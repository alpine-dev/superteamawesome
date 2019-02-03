import * as firebase from "firebase";

import * as ChatWidgetState from "./ChatWidgetState";
import { onValue2 } from "./FirebaseHelpers";
import { logEvent } from "./Logger";
import * as Slack from "./SlackHelpers";
import toolbarInfoByTabId from "./toolbarInfoByTabId";

/**
 * Handles chrome.runtime onConnect events. Toolbars injected onto a page
 * will open a connection to request data from the background script.
 */
export function handleRuntimeConnect(port) {
    switch (port.name) {
        case "dashboardLoad":
            initializeDashboard(port);
            return;
        case "popupLoad":
            initializePopup(port);
            return;
        case "chatWidgetLoad":
            initializeChatWidget(port);
            return;
    }
    const tabId = port.sender.tab.id;
    const toolbarInfo = toolbarInfoByTabId[tabId];

    switch (toolbarInfo.toolbarType) {
        case "general":
            port.postMessage({ msg: "refresh" });
            break;

        case "hunt":
            initializeHuntToolbar(port, toolbarInfo);
            break;

        case "puzzle":
            initializePuzzleToolbar(port, toolbarInfo);
            break;
    }
}

function initializeHuntToolbar(port, toolbarInfo) {
    const tabId = port.sender.tab.id;
    const db = firebase.database();
    const currentUser = firebase.auth().currentUser;

    const huntRef = db.ref("hunts/" + toolbarInfo.huntKey);
    const puzzlesRef = db.ref("puzzles").orderByChild("hunt").equalTo(toolbarInfo.huntKey);
    const discoveredPageRef = db.ref("discoveredPages/" + toolbarInfo.huntKey)
        .orderByChild("path").equalTo(toolbarInfo.path).limitToFirst(1);

    huntRef.on("value", handleHuntValue);
    puzzlesRef.on("child_added", handlePuzzleAddedValue);
    discoveredPageRef.on("value", handleDiscoveredPageValue);

    port.onDisconnect.addListener(function() {
        huntRef.off("value", handleHuntValue);
        puzzlesRef.off("value", handlePuzzleAddedValue);
        discoveredPageRef.off("value", handleDiscoveredPageValue);
    });

    function handleHuntValue(hunt) {
        port.postMessage({
            msg: "hunt",
            data: {
                hunt: hunt.val(),
                currentUser: currentUser,
                location: toolbarInfo.locationType
            }
        });
    }

    function handlePuzzleAddedValue(p) {
        const puzzlePath = p.val().path;
        if (puzzlePath && toolbarInfo.path.startsWith(puzzlePath)) {
            toolbarInfoByTabId[tabId] = {
                toolbarType: "puzzle",
                locationType: "puzzle",
                huntKey: toolbarInfo.huntKey,
                puzzleKey: p.key,
                slackChannelId: p.val().slackChannelId
            };
            chrome.tabs.sendMessage(tabId, { msg: "refreshConnection" });
        }
    }

    function handleDiscoveredPageValue(snap) {
        // TODO only add discoveredPage if the hunt is current
        function shouldAutoIgnoreDiscoveredPage(toolbarInfo) {
            // ignore archive pages
            if (/web\.mit\.edu/i.test(toolbarInfo.host)) {
                return true;
            }
            // ignore solution pages
            if (/\/solution\//i.test(toolbarInfo.path)) {
                return true;
            }
            return false;
        }
        if (snap.numChildren() === 0) {
            if (shouldAutoIgnoreDiscoveredPage(toolbarInfo)) {
                return console.log("[auto-ignore/discoveredPages]",
                    toolbarInfo.host, toolbarInfo.path, toolbarInfo.title);
            }
            console.log("[firebase/discoveredPages]",
                toolbarInfo.host, toolbarInfo.path, toolbarInfo.title);
            const pushed = db.ref("discoveredPages/" + toolbarInfo.huntKey).push({
                host: toolbarInfo.host,
                path: toolbarInfo.path,
                title: toolbarInfo.title
            });
            logEvent({
                name: "DiscoveredPageAdded",
                id: pushed.key
            });
        } else {
            snap.forEach(function(dp) {
                // Monitor and send updates to toolbar
                port.postMessage({
                    msg: "discoveredPage",
                    data: dp.val()
                });
            });
        }
    }
}

function initializePuzzleToolbar(port, toolbarInfo) {
    // This is a hack. When the port disconnects, we should cancel all firebase listeners,
    // but some of the nested queries on users/ are hard to cancel. So we'll just set a flag
    // when the port is disconnected and noop when the queries return.
    let portDisconnected = false;

    const tabId = port.sender.tab.id;
    const db = firebase.database();
    const currentUser = firebase.auth().currentUser;

    const puzzleRef = db.ref("puzzles/" + toolbarInfo.puzzleKey);
    const huntRef = db.ref("hunts/" + toolbarInfo.huntKey);

    const puzzleHierarchy = [];
    function traverseParents(puzzleKey) {
        db.ref("puzzles/" + puzzleKey)
            .once("value", function(puzzle) {
                if (portDisconnected) {
                    return;
                }
                puzzleHierarchy.unshift(Object.assign({}, puzzle.val(), {
                    key: puzzle.key
                }));
                if (puzzle.val().parents != null && puzzle.val().parents.length > 0) {
                    puzzle.val().parents.forEach(function(parentKey) {
                        traverseParents(parentKey);
                    });
                } else if (puzzle.val().parent) {
                    traverseParents(puzzle.val().parent);
                } else {
                    port.postMessage({
                        msg: "puzzle",
                        data: { hierarchy: puzzleHierarchy }
                    });
                }
            });
    }
    traverseParents(toolbarInfo.puzzleKey);

    const detachPuzzleAndHuntRefs = onValue2(puzzleRef, huntRef, function(puzzle, hunt) {
        port.postMessage({
            msg: "puzzle",
            data: {
                hunt: hunt.val(),
                puzzle: puzzle.val(),
                currentUser: currentUser,
                location: toolbarInfo.locationType
            }
        });
    });

    function handleConnectedValue(snap) {
        if (snap.val()) {
            // When firebase is next disconnected, remove self as viewer
            viewRef.onDisconnect().remove();
            // Add currentUser as a viewer of the puzzle
            viewRef.set({
                tabHidden: false,
                idle: false
            });
            logEvent({
                name: "PuzzleViewerAdded",
                puzzleId: toolbarInfo.puzzleKey,
                tabId: tabId
            });
        }
    }

    function handlePuzzleViewersValue(snap) {
        const changeId = ++currentViewersChangeId;
        const viewers = [];
        const numViewers = snap.numChildren();
        let numUsersFetched = 0;
        snap.forEach(function(viewer) {
            db.ref("users/" + viewer.key).once("value", function(user) {
                if (currentViewersChangeId !== changeId || portDisconnected) {
                    return;
                }
                let allTabsHidden = true;
                let allTabsIdle = true;
                viewer.forEach(function(client) {
                    allTabsHidden = allTabsHidden && client.val().tabHidden;
                    allTabsIdle = allTabsIdle && client.val().idle;
                });
                viewers.push({
                    id: user.key,
                    displayName: user.val().displayName,
                    photoUrl: user.val().photoUrl,
                    isIdle: allTabsIdle,
                    isPuzzleVisible: !allTabsHidden
                });
                if (++numUsersFetched === numViewers) {
                    port.postMessage({
                        msg: "puzzleViewers",
                        data: { viewers: viewers }
                    });
                }
            });
        });
    }

    const viewRef = db.ref("puzzleViewers").child(toolbarInfo.puzzleKey)
        .child(currentUser.uid).child(tabId);
    const isConnectedRef = db.ref(".info/connected");
    isConnectedRef.on("value", handleConnectedValue);

    let currentViewersChangeId = 0;
    const viewersRef = db.ref("puzzleViewers/" + toolbarInfo.puzzleKey);
    viewersRef.on("value", handlePuzzleViewersValue);

    const unsubscribeSlackState = Slack.onConnectStateChanged(
        function(state) {
            port.postMessage({
                msg: "slackConnectionStatus",
                status: state
            });
        });
    const unsubscribeChannel = Slack.subscribeToChannel(
        `toolbar${tabId}`, toolbarInfo.slackChannelId, function(msg, channel) {
            port.postMessage({
                msg: "slackChannel",
                data: { channel: channel }
            })
        });

    port.onDisconnect.addListener(function() {
        portDisconnected = true;
        detachPuzzleAndHuntRefs();
        isConnectedRef.off("value", handleConnectedValue);
        viewersRef.off("value", handlePuzzleViewersValue);

        unsubscribeSlackState();
        unsubscribeChannel();

        // Remove self as viewer. Note that this must happen last;
        // Otherwise, the viewersRef will be notified of changes and
        // attempt to post a message on the disconnected port.
        viewRef.remove();

        logEvent({
            name: "PuzzleViewerRemoved",
            puzzleId: toolbarInfo.puzzleKey,
            tabId: tabId
        });
    });
}


function initializeDashboard(port) {
    console.log("[chrome.runtime.onConnect]", "dashboardLoad");
    const db = firebase.database();
    const currentHuntRef = db.ref("currentHunt");
    const viewersRef = db.ref("puzzleViewers");
    let huntRef;
    let puzzlesRef;

    const unsubscribeAuth = firebase.auth().onAuthStateChanged(function(userOrNull) {
        port.postMessage({
            msg: "auth",
            user: userOrNull
        });
        if (userOrNull) {
            currentHuntRef.on("value", handleCurrentHuntValue, handleCurrentHuntFailure);
            viewersRef.on("value", handleViewersValue);
        }
    });

    port.onDisconnect.addListener(function() {
        unsubscribeAuth();
        if (huntRef) huntRef.off("value", handleHuntValue);
        if (puzzlesRef) puzzlesRef.off("value", handlePuzzlesValue);
        if (viewersRef) viewersRef.off("value", handleViewersValue);
        if (currentHuntRef) currentHuntRef.off("value", handleCurrentHuntValue);
    });

    function handleCurrentHuntValue(currentHuntSnap) {
        if (huntRef) huntRef.off("value", handleHuntValue);
        if (puzzlesRef) puzzlesRef.off("value", handlePuzzlesValue);
        const currentHuntKey = currentHuntSnap.val();

        huntRef = db.ref("hunts/" + currentHuntKey);
        huntRef.on("value", handleHuntValue);
        puzzlesRef = db.ref("puzzles").orderByChild("hunt").equalTo(currentHuntKey);
        puzzlesRef.on("value", handlePuzzlesValue);
    }
    function handleCurrentHuntFailure(error) {
        if (error.code === "PERMISSION_DENIED") {
            port.postMessage({
                msg: "permissionDenied"
            });
        }
    }
    function handleHuntValue(huntSnap) {
        port.postMessage({
            msg: "hunt",
            hunt: huntSnap.val()
        });
    }
    function handlePuzzlesValue(puzzlesSnap) {
        var puzzles = [];
        puzzlesSnap.forEach(function(puzzle) {
            puzzles.push(Object.assign({}, puzzle.val(), {
                key: puzzle.key
            }))
        });
        puzzles.sort(function(p1, p2) {
            // sort by createdAt descending
            return new Date(p2.createdAt).getTime() -
                new Date(p1.createdAt).getTime();
        });
        port.postMessage({
            msg: "puzzles",
            puzzles: puzzles
        });
    }
    function handleViewersValue(viewersSnap) {
        const puzzleViewers = {};
        viewersSnap.forEach(function(viewersForPuzzle) {
            let numActiveViewers = 0;
            viewersForPuzzle.forEach(function(viewerTabs) {
                viewerTabs.forEach(function(tab) {
                    if (!tab.val().idle) {
                        numActiveViewers++;
                        return true; // stop iterating
                    }
                });
            });
            puzzleViewers[viewersForPuzzle.key] = numActiveViewers;
        });
        port.postMessage({
            msg: "puzzleViewers",
            puzzleViewers: puzzleViewers
        });
    }
}

function initializePopup(port) {
    console.log("[chrome.runtime.onConnect]", "popupLoad");
    const db = firebase.database();
    const currentHuntRef = db.ref("currentHunt");
    const viewersRef = db.ref("puzzleViewers");
    let huntRef;
    let puzzlesRef;

    const unsubscribeAuth = firebase.auth().onAuthStateChanged(function(userOrNull) {
        port.postMessage({
            msg: "auth",
            user: userOrNull
        });

        currentHuntRef.on("value", handleCurrentHuntValue, handleCurrentHuntFailure);
        viewersRef.on("value", handleViewersValue);
    });

    const unsubscribeSlackState = Slack.onConnectStateChanged(function(state) {
        port.postMessage({
            msg: "slackConnectionStatus",
            status: state
        });
    });

    port.onDisconnect.addListener(function() {
        unsubscribeAuth();
        unsubscribeSlackState();
        if (huntRef) huntRef.off("value", handleHuntValue);
        if (puzzlesRef) puzzlesRef.off("value", handlePuzzlesValue);
        if (viewersRef) viewersRef.off("value", handleViewersValue);
        if (currentHuntRef) currentHuntRef.off("value", handleCurrentHuntValue);
    });

    function handleCurrentHuntValue(currentHuntSnap) {
        if (huntRef) huntRef.off("value", handleHuntValue);
        if (puzzlesRef) puzzlesRef.off("value", handlePuzzlesValue);
        const currentHuntKey = currentHuntSnap.val();

        huntRef = db.ref("hunts/" + currentHuntKey);
        huntRef.on("value", handleHuntValue);
        puzzlesRef = db.ref("puzzles").orderByChild("hunt").equalTo(currentHuntKey);
        puzzlesRef.on("value", handlePuzzlesValue);
    }
    function handleCurrentHuntFailure(error) {
        if (error.code === "PERMISSION_DENIED") {
            port.postMessage({
                msg: "permissionDenied"
            });
        }
    }
    function handleHuntValue(huntSnap) {
        port.postMessage({
            msg: "hunt",
            hunt: huntSnap.val()
        });
    }
    function handlePuzzlesValue(puzzlesSnap) {
        const puzzles = [];
        puzzlesSnap.forEach(function(puzzle) {
            puzzles.push(Object.assign({}, puzzle.val(), {
                key: puzzle.key
            }))
        });
        puzzles.sort(function(p1, p2) {
            // sort by createdAt descending
            return new Date(p2.createdAt).getTime() -
                new Date(p1.createdAt).getTime();
        });
        port.postMessage({
            msg: "puzzles",
            puzzles: puzzles
        });
    }
    function handleViewersValue(viewersSnap) {
        const puzzleViewers = {};
        viewersSnap.forEach(function(viewersForPuzzle) {
            let numActiveViewers = 0;
            viewersForPuzzle.forEach(function(viewerTabs) {
                viewerTabs.forEach(function(tab) {
                    if (!tab.val().idle) {
                        numActiveViewers++;
                        return true; // stop iterating
                    }
                });
            });
            puzzleViewers[viewersForPuzzle.key] = numActiveViewers;
        });
        port.postMessage({
            msg: "puzzleViewers",
            puzzleViewers: puzzleViewers
        });
    }
}

function initializeChatWidget(port) {
    const tabId = port.sender.tab.id;
    const toolbarInfo = toolbarInfoByTabId[tabId];

    if (toolbarInfo.toolbarType === "puzzle")  {
        sendChannelInfo(toolbarInfo.slackChannelId, port);
    } else {
        sendChannelInfo("C03A0NUTV", port);
    }
}

function sendChannelInfo(channelId, port) {
    Promise.all([
        new Promise(resolve => Slack.getChannelInfo(channelId, resolve)),
        new Promise(resolve => Slack.getChannelHistory(channelId, resolve))
    ]).then(([channelInfo, channelHistory]) => {
        port.postMessage({
            msg: "slackChannelInfo",
            data: {
                connectionInfo: Slack.connectionInfo,
                channel: channelInfo.channel,
                messages: channelHistory.messages.reverse()
            }
        });
    });

    const unsubscribeSlackState = Slack.onConnectStateChanged(
        function(state) {
            port.postMessage({
                msg: "slackConnectionStatus",
                status: state
            });
        });
    const unsubscribeChannel = Slack.subscribeToChannel(
        `chat${port.sender.tab.id}`, channelId, (msg, channel) => {
            switch (msg.type) {
                case "message":
                    port.postMessage({
                        msg: "slackMessage",
                        data: msg
                    });
                    break;
            }
            console.log("[chat channel]", channel);
            port.postMessage({
                msg: "slackChannelInfo",
                data: { channel }
            });
        });

    port.onDisconnect.addListener(function() {
        unsubscribeSlackState();
        unsubscribeChannel();
    });
}
