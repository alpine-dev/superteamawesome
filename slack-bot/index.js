var admin = require('firebase-admin');
var config = require('./config').config;
var WebClient = require('@slack/client').WebClient;

const postChannel = 'site-dev';
var startTime = Date.now();


// Initialization
var slack = new WebClient(config.slack.token);
admin.initializeApp(config.firebase);


// Firebase handlers initialization
admin.database().ref('eventLogs').on('child_added', handleEvent);

function handleEvent(snap) {
    event = snap.val();
    if (event.timestampMs > startTime) {
        if (event.name === 'PuzzleCreated') {
            admin.database().ref('puzzles').child(event.puzzleId).once("value", function(snap) {
                postSlackMessage(postChannel, makeNewPuzzleMessage(snap.val()));
            });
        } else if (event.name === 'PuzzleSolutionChanged') {
            var puzzleRef = admin.database().ref('puzzles').child(event.puzzleId);
            var userRef = admin.database().ref('users').child(event.userId);

            onceValue2(puzzleRef, userRef, function(puzzle, user) {
                postSlackMessage(postChannel, makeSolvedMessage(puzzle, user), ':pikadance:');
            });
        }
    }
}


// Slack
function postSlackMessage(channel, message, emoji) {
    emoji = (typeof emoji !== 'undefined') ? emoji : ':callitin:';
    slack.chat.postMessage(
        channel,
        message, {
            icon_emoji: emoji,
            username: 'SuperTeamAwesomeBot',
        },
        function(err, res) {
        if (err) {
            console.log('Error:', err);
        } else {
            console.log('Message sent: ', message);
        }
    });
}


// Utility
function makeSolvedMessage(puzzle, user) {
    return makeSlackUserTag(user) + ' has solved ' + puzzle.name +
           ' (' + makePuzzleAddress(puzzle) + ') :correct:' +
           (puzzle.solution ? '\n Solution: `' + puzzle.solution + '`' : '');
}

function makeNewPuzzleMessage(puzzle) {
    return puzzle.name + (puzzle.isMeta ? ' META' : '') + ' has been unlocked!\n' +
           makePuzzleAddress(puzzle) + '\n' +
           'Join the slack channel ' + makeSlackChannelLink(puzzle);
}

function makePuzzleAddress(puzzle) {
    return 'http://' + puzzle.host + puzzle.path;
}

function makeSlackChannelLink(puzzle) {
    return '<#' + puzzle.slackChannelId + '|' + puzzle.slackChannel + '>';
}

function makeSlackUserTag(user) {
    if (user.slackUserId) {
        return '<@' + user.slackUserId + '>';
    }
    else {
        return user.displayName;
    }
}


// Stolen from Vincent
/**
 * Takes two firebase refs and attaches `value` event listeners on them, calling
 * the given callback when both are resolved and for every update after. The caller
 * is responsible for calling the returned detach function.
 */
function onValue2(ref1, ref2, callback) {
    var snap1 = null;
    var snap2 = null;
    function update() {
        if (snap1 && snap1.val() &&
            snap2 && snap2.val()) {
            callback(snap1, snap2);
        }
    }
    function on1(snap) { snap1 = snap; update(); }
    function on2(snap) { snap2 = snap; update(); }
    ref1.on("value", on1);
    ref2.on("value", on2);

    return function detach() {
        ref1.off("value", on1);
        ref2.off("value", on2);
    };
}

// The same thing as above, but only once, and passes the val()'s
function onceValue2(ref1, ref2, callback) {
    var snap1 = null;
    var snap2 = null;
    function update() {
        if (snap1 && snap1.val() &&
            snap2 && snap2.val()) {
            callback(snap1.val(), snap2.val());
        }
    }
    function on1(snap) { snap1 = snap; update(); }
    function on2(snap) { snap2 = snap; update(); }
    ref1.once("value", on1);
    ref2.once("value", on2);
}