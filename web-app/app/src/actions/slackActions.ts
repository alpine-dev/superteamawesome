import { Dispatch } from "redux";

import { slack } from "../services";
import { IAppState } from "../state";
import { firebaseAuth, firebaseDatabase } from "../auth";
import {
    asyncActionFailedPayload,
    asyncActionInProgressPayload, 
    asyncActionSucceededPayload,
} from "./loading";

export const LOAD_SLACK_TOKEN_ACTION = "LOAD_SLACK_TOKEN";
export const LOAD_SLACK_TEAM_ID_ACTION = "LOAD_SLACK_TEAM_ID";
export function loadSlackTokenAction(code: string) {
    return (dispatch: Dispatch<IAppState>) => {
        dispatch(asyncActionInProgressPayload<string>(LOAD_SLACK_TOKEN_ACTION));
        firebaseAuth().onAuthStateChanged((user: firebase.UserInfo) => {
            slack.oauth.access(code)
                .then((token) => {
                    firebaseDatabase
                        .ref(`userPrivateData/${user.uid}/slackAccessToken`)
                        .set(token)
                        .then(() => {
                            slack.team.info(token).then((teamInfo) => {
                                dispatch(asyncActionSucceededPayload<string>(LOAD_SLACK_TEAM_ID_ACTION, teamInfo.id));
                                dispatch(asyncActionSucceededPayload<string>(LOAD_SLACK_TOKEN_ACTION, token));
                            })
                        });
                })
                .catch((error: Error) => {
                    dispatch(asyncActionFailedPayload<string>(LOAD_SLACK_TOKEN_ACTION, error));
                });
        })
    };
}
