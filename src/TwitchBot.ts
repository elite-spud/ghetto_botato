import * as http from "http";
import * as https from "https";
import * as open from "open";
import { getPassword, setPassword } from "keytar";
import { IIrcBotAuxCommandConfig, IIrcBotAuxCommandGroupConfig, IIrcBotConfig, IIrcBotConnectionConfig, IJoinMessageDetail, IPartMessageDetail, IPrivMessageDetail, IrcBotBase, IUserDetail } from "./IrcBot";
import { ConsoleColors } from "./ConsoleColors";
import { Future } from "./Future";
import { WebSocket } from "ws";
// import { randomInt } from "crypto";

export interface ITwitchUserDetail extends IUserDetail {
    /** globally unique id for a twitch user (persists between username changes) */
    id: string;
}

export interface ITwitchBotConfig extends IIrcBotConfig {
    connection: ITwitchBotConnectionConfig;
}

export interface ITwitchBotConnectionConfig extends IIrcBotConnectionConfig {
    twitch: {
        oauth: {
            clientId: string;
            clientSecret: string;
            scope: string;
        }
    }
}

export interface TwitchUserInfoResponse {
    data: {
            id: string;
            login: string;
            display_name: string;
            created_at: string;
    }[],
}

export interface TwitchGetChannelInfo {
    broadcaster_id: string;
    broadcaster_login: string;
    broadcaster_name: string;
    broadcaster_language: string;
    game_name: string;
    game_id: string;
    title: string;
    delay: number;
    tags: string[];
}

export interface TwitchGetChannelInfoResponse {
    data: TwitchGetChannelInfo[];
}

export interface TwitchSearchChannelInfo {
    broadcaster_language: string;
    broadcaster_login: string;
    display_name: string;
    game_id: string;
    game_name: string;
    id: string;
    is_live: boolean;
    tags: string[];
    thumbnail_url: string;
    title: string;
    started_at: string;
}

export interface TwitchSearchChannelsResponse {
    data: TwitchSearchChannelInfo[],
    pagination: {
    },
}

export interface TwitchGetStreamInfo {
    id: string; // Stream Id
    user_id: string;
    user_name: string;
    game_id: string;
    game_name: string;
    type: "live" | string;
    title: string;
    viewer_count: number;
    /** ISO format date string */
    started_at: string;
    language: string;
    thumbnail_url: string;
    tag_ids: string[];
}

export interface TwitchGetStreamsResponse {
    data: TwitchGetStreamInfo[],
    pagination: {
    },
}

export interface TwitchErrorResponse {
    error: string,
    status: number, // HTTP status code
    message: string,
}

export interface ITwitchBotAuxCommandConfig extends IIrcBotAuxCommandConfig {
    /** Only post automatically (as part of a timer) when these categories are being streamed */
    autoPostGameWhitelist?: string[];
    /** Only post automatically (as part of a timer) if the title contains any of these strings */
    autoPostIfTitleContainsAny?: string[];
}

export interface TwitchAppToken {
    access_token: string;
    expires_in: number;
}

export interface TwitchUserToken {
    access_token: string,
    expires_in: number,
    refresh_token: string,
    scope: string[],
    token_type: string,
    /** The access token used to access the Twitch API has its own associated userId, so we have to store it separately from the username/userId map */
    user_id?: string,
}

export interface TwitchEventSubWebsocketWelcome {
    metadata: {
        /** Guid */
        message_id: string,
        message_type: "session_welcome",
        message_timestamp: string,
    },
    payload: {
        session: {
            id: string,
            status: string,
            connected_at: string,
            keepalive_timeout_seconds: 10,
            reconnect_url: null,
        }
    }
}

/** https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription */
export interface TwitchEventSubCreateSubscription {
    type: string,
    version: string,
    condition: {
    }
    transport: {
        method: "webhook" | "websocket" | string,
        /** For webhooks only */
        callback?: string,
        /** 10 - 100 characters */
        secret?: string,
        /** Identifies a WebSocket */
        session_id?: string,
    }
}

export type TwitchPrivMessageTagKeys = "badge-info" | "badges" | "client-nonce" | "color" | "display-name" | "emotes" | "flags" | "id" | "mod" | "room-id" | "subscriber" | "tmi-sent-ts" | "turbo" | "user-id" | "user-type" | string;
export type TwitchBadgeTagKeys = "admin" | "bits" | "broadcaster" | "global_mod" | "moderator" | "subscriber" | "staff" | "turbo" | string;

export abstract class TwitchBotBase<TUserDetail extends ITwitchUserDetail = ITwitchUserDetail> extends IrcBotBase<TUserDetail> {
    public static readonly maxChatMessageLength = 500
    protected static readonly _knownConfig: { encoding: "utf8" } = { encoding: "utf8" };

    public declare readonly _config: ITwitchBotConfig;
    protected _userAccessToken = new Future<TwitchUserToken>();
    protected _twitchAppToken = new Future<TwitchAppToken>();
    protected _twitchIdByUsername: { [key: string]: string } = {}
    protected readonly userAccessTokenAccountName = "default"; // TODO: find a good replacement for this
    protected _twitchEventSub: WebSocket;
    protected _twitchEventSubHeartbeatInterval: NodeJS.Timer; 

    public constructor(connection: ITwitchBotConnectionConfig, auxCommandGroups: IIrcBotAuxCommandGroupConfig[], configDir: string) {
        super(Object.assign(
            TwitchBotBase._knownConfig,
            { connection, auxCommandGroups, configDir }
        ));
    }

    /**
     * Twitch uses a separate userId that persists across usernames
     * @param username 
     * @returns 
     */
    protected override async getUserIdForUsername(username: string): Promise<string> {
        try {
            const userId = await this.getTwitchIdWithCache(username);
            return userId;
        } catch (err) {
            throw new Error(`Error receiving user id for username ${username} from twitch: ${err.message}`);
        }
    }

    protected override async callCommandFunctionFromConfig(command: ITwitchBotAuxCommandConfig, channel: string): Promise<boolean> {
        let streamDetails: TwitchGetChannelInfo | undefined = undefined;
        try {
            if (command.autoPostGameWhitelist) {
                streamDetails = streamDetails ?? await this.getChannelDetails(this.twitchChannelName); // TODO: parameterize this
                let gameInWhitelist = false;
                for (const gameName of command.autoPostGameWhitelist) {
                    if (streamDetails.game_name === gameName) {
                        gameInWhitelist = true;
                        break;
                    }
                }

                if (!gameInWhitelist) {
                    return false;
                }
            }

            if (command.autoPostIfTitleContainsAny) {
                streamDetails = streamDetails ?? await this.getChannelDetails(this.twitchChannelName); // TODO: parameterize this
                let substringMatchesInTitle = false;
                for (const substring of command.autoPostIfTitleContainsAny) {
                    if (streamDetails.title.includes(substring)) {
                        substringMatchesInTitle = true;
                        break;
                    }
                }

                if (!substringMatchesInTitle) {
                    return false;
                }
            }
        } catch (err) {
            this.onError(err);
            return false;
        }

        return await super.callCommandFunctionFromConfig(command, channel);
    }

    protected override async trackUsersInChat(secondsToAdd: number): Promise<void> {
        const isChannelLive = await this.isChannelLive(this.twitchChannelName);
        if (!isChannelLive) {
            return;
        }

        super.trackUsersInChat(secondsToAdd);
    }

    protected override async handleJoinMessage(messageDetail: IJoinMessageDetail): Promise<void> {
        super.handleJoinMessage(messageDetail);

        const userDetail = await this.getUserDetailWithCache(messageDetail.username);
        if (userDetail.username !== messageDetail.username) { // Locally stored username may not match because of a username change on Twitch
            if (userDetail.oldUsernames === undefined) {
                userDetail.oldUsernames = [];
            }
            userDetail.oldUsernames.push({ username: userDetail.username, lastSeenInChat: userDetail.lastSeenInChat ?? new Date() });
            
            userDetail.username = messageDetail.username;
        }
    }

    protected override async handlePartMessage(messageDetail: IPartMessageDetail): Promise<void> {
        super.handlePartMessage(messageDetail);
        
        // Delete the username-twitchId pair to ensure it is refreshed every time someone joins again
        delete this._twitchIdByUsername[messageDetail.username];
    }

    protected get twitchChannelName(): string {
        const twitchChannelName = this._config.connection.server.channel.slice(1, this._config.connection.server.channel.length); // strip the leading # from the IRC channel name
        return twitchChannelName;
    }

    protected async isChannelLive(channelName: string): Promise<boolean> {
        try {
            const channelInfoResponse = await this.getStreamDetails(channelName);
            const channelIsLive = channelInfoResponse.type === "live";
            return channelIsLive;
        } catch (err) {
            return false;
        }
    }

    protected async getChannelDetails(channelName: string): Promise<TwitchGetChannelInfo> {
        const broadcasterId = await this.getTwitchIdWithCache(channelName);

        const appToken = await this._twitchAppToken;
        return new Promise<TwitchGetChannelInfo>((resolve, reject) => {
    
            const options = {
                headers: {
                    Authorization: `Bearer ${appToken.access_token}`,
                    "client-id": `${this._config.connection.twitch.oauth.clientId}`,
                },
            };
            const request = https.get(`https://api.twitch.tv/helix/channels?broadcaster_id=${broadcasterId}`, options, (response) => {
                    response.on("data", (data) => {
                        const responseJson: TwitchGetChannelInfoResponse | TwitchErrorResponse = JSON.parse(data.toString("utf8"));
                        const errorResponse = responseJson as TwitchErrorResponse;
                        if (errorResponse.error) {
                            reject(`Error retrieving channel info from twitch API: ${errorResponse.status} ${errorResponse.error}: ${errorResponse.message}`);
                            return;
                        }

                        const channelInfoResponse = responseJson as TwitchGetChannelInfoResponse;
                        if (channelInfoResponse.data.length > 1) {
                            reject("More than one channel info received, expected only one.");
                            return;
                        }
                        if (channelInfoResponse.data.length === 0) {
                            reject("No channel info received in response, expected one.");
                            return;
                        }
                        resolve(channelInfoResponse.data[0]);
                        return;
                    });
                });
            request.on("error", (err) => {
                console.log("Error sending auth token request to twitch:");
                console.log(err);
                reject(err);
            });
        });
    }

    protected async getStreamDetails(channelName: string): Promise<TwitchGetStreamInfo> {
        const appToken = await this._twitchAppToken;
        return new Promise<TwitchGetStreamInfo>((resolve, reject) => {
    
            const options = {
                headers: {
                    Authorization: `Bearer ${appToken.access_token}`,
                    "client-id": `${this._config.connection.twitch.oauth.clientId}`,
                },
            };
            const request = https.get(`https://api.twitch.tv/helix/streams?user_login=${channelName}`, options, (response) => {
                    response.on("data", (data) => {
                        const responseJson: TwitchGetStreamsResponse | TwitchErrorResponse = JSON.parse(data.toString("utf8"));
                        const errorResponse = responseJson as TwitchErrorResponse;
                        if (errorResponse.error) {
                            reject(`Error retrieving channel info from twitch API: ${errorResponse.status} ${errorResponse.error}: ${errorResponse.message}`);
                            return;
                        }

                        const channelInfoResponse = responseJson as TwitchGetStreamsResponse;
                        if (channelInfoResponse.data.length > 1) {
                            reject("More than one stream info received, expected only one.");
                            return;
                        }
                        if (channelInfoResponse.data.length === 0) {
                            reject("No stream info received in response, expected one.");
                            return;
                        }
                        resolve(channelInfoResponse.data[0]);
                        return;
                    });
                });
            request.on("error", (err) => {
                console.log("Error sending auth token request to twitch:");
                console.log(err);
                reject(err);
            });
        });
    }

    protected async getTwitchIdWithCache(username?: string): Promise<string> {
        let id: string | undefined = username
            ? this._twitchIdByUsername[username]
            : (await this._userAccessToken).user_id;
        if (!id) {
            try {
                id = await this.getTwitchId(username);
            } catch (err) {
                throw new Error(`Error retrieving twitch user id: ${err}`);
            }

            if (username) {
                this._twitchIdByUsername[username] = id;
            } else {
                (await this._userAccessToken).user_id = id;
            }
        }
        
        return id;
    }

    /**
     * 
     * @param username Optional. if not provided, retrieves the twitch id for the active user access token
     * @returns 
     */
    protected async getTwitchId(username?: string): Promise<string> {
        return new Promise<string>(async (resolve, reject) => {

            if (!username) {
                reject("Cannot retrieve user id for user access token unless token already exists!");
                return;
            }

            const options = {
                headers: {
                    Authorization: username
                        ? `Bearer ${(await this._twitchAppToken).access_token}`
                        : `Bearer ${(await this._userAccessToken).access_token}`,
                    "client-id": `${this._config.connection.twitch.oauth.clientId}`,
                },
            };
            const url = `https://api.twitch.tv/helix/users${username ? `?login=${username}` : ""}`;
            const request = https.get(url, options, (response) => {
                response.on("data", (data) => {
                    const responseJson: TwitchUserInfoResponse | TwitchErrorResponse = JSON.parse(data.toString("utf8"));
                    const errorResponse = responseJson as TwitchErrorResponse;
                    if (errorResponse.error) {
                        reject(`Error retrieving user info for username ${username} from twitch API: ${errorResponse.status} ${errorResponse.error}: ${errorResponse.message}`);
                        return;
                    }

                    const userInfoResponse = responseJson as TwitchUserInfoResponse;
                    const id = userInfoResponse.data[0]?.id;
                    if (id) {
                        resolve(id);
                        return;
                    }
                    reject(`Unable to parse user info from twitch API response: ${JSON.stringify(userInfoResponse)}`);
                });
            });
            request.on("error", (err) => {
                console.log("Error sending auth token request to twitch:");
                console.log(err);
                reject(err);
            });
        });
    }

    protected shouldIgnoreTimeoutRestrictions(messageDetail: IPrivMessageDetail): boolean {
        const tags = this.parseTwitchTags(messageDetail.tags);
        const badgeVersionsByBadgeName = this.parseTwitchBadges(tags.badges);
        if (badgeVersionsByBadgeName.broadcaster || badgeVersionsByBadgeName.moderator) {
            return true;
        }
        return false;
    }

    protected parseTwitchBadges(badges?: string): { [badgeName in TwitchBadgeTagKeys]: string } {
        if (!badges) {
            return {};
        }

        const badgeVersionsByBadgeName: { [badgeName in TwitchBadgeTagKeys]: string } = {};
        const badgesSplit = badges.split(",");
        for (const badge of badgesSplit) {
            const badgeSplit = badge.split("/");
            if (badgeSplit.length !== 2) {
                console.log(`Failed to parse a twitch badge tag: ${badge}. Expected only 2 parts after splitting on '/'`);
                continue;
            }
            const badgeName = badgeSplit[0];
            const badgeVersion = badgeSplit[1];
            badgeVersionsByBadgeName[badgeName] = badgeVersion;
        }
        return badgeVersionsByBadgeName;
    }

    protected parseTwitchTags(tags?: string): { [key in TwitchPrivMessageTagKeys]: string } {
        if (!tags) {
            return {};
        }

        const parsedTags: { [key in TwitchPrivMessageTagKeys]: string } = {};
        const tagsCleaned = tags.startsWith("@")
            ? tags.slice(1, tags.length)
            : tags;
        const tagsStrArr = tagsCleaned.split(";");
        for (const tag of tagsStrArr) {
            const splitTag = tag.split("=");
            if (splitTag.length !== 2) {
                console.log(`Failed to parse a twitch tag: ${tag}. Expected only 2 parts after splitting on '='`);
                continue;
            }
            const key = splitTag[0];
            const value = splitTag[1];
            parsedTags[key] = value;
        }

        return parsedTags;
    }

    protected async loadAuthToken(): Promise<void> {
        console.log("Performing Request...");
        const promise = new Promise<void>((resolve, reject) => {
            const url = `https://id.twitch.tv/oauth2/token?client_id=${this._config.connection.twitch.oauth.clientId}&client_secret=${this._config.connection.twitch.oauth.clientSecret}&grant_type=client_credentials&scope=${this._config.connection.twitch.oauth.scope}`;
            console.log(url);
            console.log(encodeURIComponent(url));
            const authRequest = https.request(url, {
                    method: "POST",
                    port: 443,
                },
                (response) => {
                    response.on("data", (data: Buffer) => {
                        const responseJson = JSON.parse(data.toString("utf8"));
                        if (responseJson.access_token) {
                            this._twitchAppToken.resolve(responseJson);
                            console.log("Successfully obtained API token from twitch.");
                            resolve();
                        } else {
                            const message = `Issue retrieving access token from twitch: ${responseJson}`
                            console.log(message);
                            reject(message);
                        }
                    });
                });

            authRequest.on("error", (err) => {
                console.log("Error sending auth token request to twitch:");
                console.log(err);
                reject(err);
            });
            authRequest.end();
            // TODO: Setup token refresh
        });
        return promise;
    }

    protected abstract getServiceName(): string;

    protected async refreshUserToken(refreshToken: string): Promise<TwitchUserToken> {
        console.log(`Attempting to obtain user access token via refresh token...`);

        const tokenRequestBodyProps: { [key: string]: string } = {
            client_id: this._config.connection.twitch.oauth.clientId,
            client_secret: this._config.connection.twitch.oauth.clientSecret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
        };
        const tokenRequestBody = Object.keys(tokenRequestBodyProps)
            .map(n => encodeURIComponent(n) + '=' + encodeURIComponent(tokenRequestBodyProps[n])).join('&');
        const tokenResponse = await fetch(`https://id.twitch.tv/oauth2/token`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: tokenRequestBody,
        });
        const tokenResponseJson: any = await tokenResponse.json();
        console.log(`User access token successfully obtained via refresh token`);
        console.log(tokenResponseJson);
        return tokenResponseJson;
    }

    protected storeUserTokenResponse(tokenResponse: TwitchUserToken, ): void {
        setPassword(this.getServiceName(), this.userAccessTokenAccountName, JSON.stringify(tokenResponse));
        this._userAccessToken.resolve(tokenResponse);
        console.log(`Successfully stored user token response`);
    }

    protected async loadUserToken(): Promise<void> {
        const clientId = this._config.connection.twitch.oauth.clientId;
        // Keep alphabetical for easier comparison against returned scope in refresh token
        const scope = `bits:read channel:read:redemptions channel:read:subscriptions moderator:manage:banned_users`;

        const storedTokenString = await getPassword(this.getServiceName(), this.userAccessTokenAccountName);
        if (storedTokenString) {
            console.log(`Stored user access token found.`);
            console.log(storedTokenString);
            const storedToken: TwitchUserToken = JSON.parse(storedTokenString);
            try {
                const refreshTokenResponse = await this.refreshUserToken(storedToken.refresh_token);
                if (refreshTokenResponse.scope.join(" ") !== scope) {
                    throw new Error(`Refresh token scope does not match requested scope (${scope} !== ${refreshTokenResponse.scope.join(" ")})`);
                }
                this.storeUserTokenResponse(refreshTokenResponse);
                return;
            } catch (err) {
                console.log(`Token Refresh failed: ${err}`);
            }
        }
        
        console.log(`Obtaining user access token from scratch...`);
        const redirectUrl = `http://localhost:3000`;
        const handleRequest = async (httpRequest: http.IncomingMessage, _httpResponse: http.ServerResponse) => {
            if (!httpRequest.url) {
                return;
            }
            console.log(`Incoming Request: ${httpRequest.url}`);
            const incomingUrl = new URL(`${redirectUrl}${httpRequest.url}`);
            const authCode = incomingUrl.searchParams.get("code");
            if (!authCode) {
                throw new Error(`Could not load user token: no auth code returned`);
            }

            const tokenRequestBodyProps: { [key: string]: string } = {
                client_id: this._config.connection.twitch.oauth.clientId,
                client_secret: this._config.connection.twitch.oauth.clientSecret,
                code: authCode,
                grant_type: "authorization_code",
                redirect_uri: redirectUrl,
            }
            const tokenRequestBody = Object.keys(tokenRequestBodyProps)
                .map(n => encodeURIComponent(n) + '=' + encodeURIComponent(tokenRequestBodyProps[n])).join('&');
            const tokenResponse = await fetch(`https://id.twitch.tv/oauth2/token`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: tokenRequestBody,
            });
            const tokenResponseJson: any = await tokenResponse.json();
            if (tokenResponse.status !== 200) {
                const errMessage = `Failed to exchange authorization code for access token: ${tokenResponse.status}`;
                console.log(errMessage);
                console.log(tokenResponseJson);
                throw new Error(errMessage);
            }
            this.storeUserTokenResponse(tokenResponseJson);
        };
        const server = http.createServer(handleRequest);
        server.listen(new URL(redirectUrl).port);

        const redirect_uri = redirectUrl;
        const url = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirect_uri}&response_type=code&scope=${scope}`;
        await open(url);
    }

    public override async _startup(): Promise<void> {
        await super._startup();

        await this.loadAuthToken();
        await this.loadUserToken();

        this._twitchEventSub = new WebSocket("wss://eventsub.wss.twitch.tv/ws");
        this._twitchEventSub.on("error", (err) => this.onError(err));
        this._twitchEventSub.on("open", async () => await this.onEventSubOpen());
        this._twitchEventSub.on("message", (msg) => this.onEventSubMessage(msg));
        this._twitchEventSub.on("pong", () => this.onEventSubPong());
        this._twitchEventSub.on("close", () => console.log("EventSub CLOSED!!!!"))
        // TODO: handle reconnecting to the socket when a pong is not received

        this.sendRaw("CAP REQ :twitch.tv/membership"); // Request capability to receive JOIN and PART events from users connecting to channels)
        this.sendRaw("CAP REQ :twitch.tv/commands"); // Request capability to send & receive twitch-specific commands (timeouts, chat clears, host notifications, subscriptions, etc.)
        this.sendRaw("CAP REQ :twitch.tv/tags"); // Request capability to augment certain IRC messages with tag metadata
    }

    protected abstract getTwitchBroadcasterId(): Promise<string>;

    protected abstract getTwitchEventSubTopics(): Promise<string[]>;

    public async onEventSubOpen(): Promise<void> {
        // this._twitchEventSub.ping();
        // const getIntervalTime = () => {
        //     const bonusSeconds = randomInt(60);
        //     return (1000 * 60 * 4) + bonusSeconds;
        // }
        // this._twitchEventSubHeartbeatInterval = setInterval(() => this._twitchEventSub.ping(), getIntervalTime());

        console.log(`  ${ConsoleColors.FgYellow}${"Opened EventSub"}${ConsoleColors.Reset}\n`);

        // const userAccessToken = await this._userAccessToken;

        // const listenRequest: TwitchEventSubListenRequest = {
        //     type: "LISTEN",
        //     data: {
        //         topics: this.getTwitchEventSubTopics(),
        //         auth_token: userAccessToken.access_token,
        //     },
        // };
        // this._twitchEventSub.send(JSON.stringify(listenRequest));
        // console.log(`  ${ConsoleColors.FgYellow}${"Sent EventSub LISTEN message"}${ConsoleColors.Reset}\n`);
    }

    public async onEventSubMessage(msg: any): Promise<void> {
        console.log(`  ${ConsoleColors.FgYellow}EventSub Message Received! ${msg}${ConsoleColors.Reset}\n`);
        const messageJson: any = JSON.parse(msg.toString());
        if (messageJson.metadata.message_type === "session_welcome") {
            await this.handleEventSubWelcome(messageJson);
        }
    }

    public async handleEventSubWelcome(welcomeMessage: TwitchEventSubWebsocketWelcome): Promise<void> {
        // Websockets are read-only (aside from PONG responses), so subscriptions are set up via HTTP instead (just like webhooks)
        const body: TwitchEventSubCreateSubscription = {
            type: "channel.update",
            version: "2",
            condition: {
                broadcaster_user_id: await this.getTwitchBroadcasterId(),
            },
            transport: {
                method: "websocket",
                session_id: welcomeMessage.payload.session.id,
            }
        };
        const subscriptionResponse = await fetch(`https://api.twitch.tv/helix/eventsub/subscriptions`, {
            method: `POST`,
            headers: {
                Authorization: `Bearer ${(await this._userAccessToken).access_token}`,
                "Client-Id": `${this._config.connection.twitch.oauth.clientId}`,
                "Content-Type": `application/json`,
            },
            body: JSON.stringify(body),
        });
        console.log(`  ${ConsoleColors.FgYellow}Received subscription response!${ConsoleColors.Reset}\n`);
        console.log(await subscriptionResponse.json());
    }

    public onEventSubPong() {
        console.log(`  ${ConsoleColors.FgYellow}Pong!${ConsoleColors.Reset}\n`);
    }

    public async timeout(channelUsername: string, usernameToTimeout: string, durationSeconds: number): Promise<void> {
        const userAccessToken = await this._userAccessToken;

        console.log(`Timing out ${usernameToTimeout} in channel ${channelUsername}`)
        const broadcasterId = await this.getTwitchIdWithCache(channelUsername.replace("#", ""));
        const chatbotId = await this.getTwitchIdWithCache(this._config.connection.user.nick);
        const userIdToBan = await this.getTwitchIdWithCache(usernameToTimeout);
        const body = {
            data: {
                user_id: userIdToBan,
                duration: durationSeconds,
            }
        }

        const response = await fetch(`https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${chatbotId}`, {
            method: `POST`,
            headers: {
                Authorization: `Bearer ${userAccessToken.access_token}`,
                "Client-Id": `${this._config.connection.twitch.oauth.clientId}`,
                "Content-Type": `application/json`,
            },
            body: JSON.stringify(body),
        });
        const timeoutResponse: any = await response.json();
        if (timeoutResponse.status !== 200) {
            console.log(`Timeout request failed: ${response.status} ${response.statusText}`);
            console.log(timeoutResponse);
        } else {
            console.log(`Timeout Successful.`);
        }
    }

    public clearTimeout(channel: string, username: string): void {
        this.timeout(channel, username, 1);
    }

    public override chat(recipient: string, message: string): void {
        let actualMessage = message;
        if (message.length > TwitchBotBase.maxChatMessageLength) {
            actualMessage = "<Message was too long. Please file a bug report with the owner :)>";
            console.log(`Message too long for Twitch: ${message}`);
        }
        super.chat(recipient, actualMessage);
    }
}
