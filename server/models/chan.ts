import _ from "lodash";
import log from "../log.js";
import Config from "../config.js";
import Helper from "../helper.js";
import User from "./user.js";
import Msg from "./msg.js";
import storage from "../plugins/storage.js";
import Client from "../client.js";
import Network from "./network.js";
import Prefix from "./prefix.js";
import {MessageType, SharedMsg} from "../../shared/types/msg.js";
import {ChanType, SpecialChanType, ChanState, UserGroup} from "../../shared/types/chan.js";
import {SharedNetworkChan} from "../../shared/types/network.js";
import {messageKey} from "../../shared/messageKey.js";

export type ChanConfig = {
	name: string;
	key?: string;
	muted?: boolean;
	pinned?: boolean;
	type?: string;
};

class Chan {
	// TODO: don't force existence, figure out how to make TS infer it.
	id!: number;
	messages!: Msg[];
	name!: string;
	key!: string;
	topic!: string;
	firstUnread!: number;
	unread!: number;
	highlight!: number;
	users!: Map<string, User>;
	muted!: boolean;
	type!: ChanType;
	state!: ChanState;
	// Whether stored history has been pulled into memory (or is being pulled)
	// during this session. History is loaded on first open, not at startup.
	historyLoaded!: boolean;
	pinned!: boolean;

	isOnline?: boolean | null;
	userAway!: string | null;
	special?: SpecialChanType;
	data?: unknown;
	closed?: boolean;
	num_users?: number;
	groups?: UserGroup[];

	constructor(attr?: Partial<Chan>) {
		_.defaults(this, attr, {
			id: 0,
			messages: [],
			name: "",
			key: "",
			topic: "",
			type: ChanType.CHANNEL,
			state: ChanState.PARTED,
			firstUnread: 0,
			unread: 0,
			highlight: 0,
			users: new Map(),
			muted: false,
			pinned: false,
			historyLoaded: false,
			userAway: null,
		});

		if (this.type === ChanType.QUERY) {
			this.isOnline = this.isOnline ?? null;
		}
	}

	destroy() {
		this.dereferencePreviews(this.messages);
	}

	pushMessage(client: Client, msg: Msg, increasesUnread = false) {
		const chanId = this.id;
		msg.id = client.idMsg++;

		// If this channel is open in any of the clients, do not increase unread counter
		const isOpen = _.find(client.attachedClients, {openChannel: chanId}) !== undefined;

		if (msg.self) {
			// reset counters/markers when receiving self-/echo-message
			this.unread = 0;
			this.firstUnread = msg.id;
			this.highlight = 0;
		} else if (!isOpen) {
			if (!this.firstUnread) {
				this.firstUnread = msg.id;
			}

			if (increasesUnread || msg.highlight) {
				this.unread++;
			}

			if (msg.highlight) {
				this.highlight++;
			}
		}

		client.emit("msg", {chan: chanId, msg, unread: this.unread, highlight: this.highlight});

		// Never store messages in public mode as the session
		// is completely destroyed when the page gets closed
		if (Config.values.public) {
			return;
		}

		// showInActive is only processed on "msg", don't need it on page reload
		if (msg.showInActive) {
			delete msg.showInActive;
		}

		this.writeUserLog(client, msg);

		if (Config.values.maxHistory >= 0 && this.messages.length > Config.values.maxHistory) {
			const deleted = this.messages.splice(
				0,
				this.messages.length - Config.values.maxHistory
			);

			// If maxHistory is 0, image would be dereferenced before client had a chance to retrieve it,
			// so for now, just don't implement dereferencing for this edge case.
			if (Config.values.maxHistory > 0) {
				this.dereferencePreviews(deleted);
			}
		}
	}

	dereferencePreviews(messages: Msg[]) {
		if (!Config.values.prefetch || !Config.values.prefetchStorage) {
			return;
		}

		messages.forEach((message) => {
			if (message.previews) {
				message.previews.forEach((preview) => {
					if (preview.thumb) {
						storage.dereference(preview.thumb);
						preview.thumb = "";
					}
				});
			}
		});
	}

	getSortedUsers(irc?: Network["irc"]) {
		const users = Array.from(this.users.values());

		if (!irc || !irc.network || !irc.network.options || !irc.network.options.PREFIX) {
			return users;
		}

		const userModeSortPriority = {};
		irc.network.options.PREFIX.forEach((prefix, index) => {
			userModeSortPriority[prefix.symbol] = index;
		});

		userModeSortPriority[""] = 99; // No mode is lowest

		return users.sort(function (a, b) {
			if (a.mode === b.mode) {
				return a.nick.toLowerCase() < b.nick.toLowerCase() ? -1 : 1;
			}

			return userModeSortPriority[a.mode] - userModeSortPriority[b.mode];
		});
	}

	findMessage(msgId: number) {
		return this.messages.find((message) => message.id === msgId);
	}

	findUser(nick: string) {
		return this.users.get(nick.toLowerCase());
	}

	getUser(nick: string) {
		return this.findUser(nick) || new User({nick}, new Prefix([]));
	}

	setUser(user: User) {
		this.users.set(user.nick.toLowerCase(), user);
	}

	removeUser(user: User) {
		this.users.delete(user.nick.toLowerCase());
	}

	/**
	 * Get a clean clone of this channel that will be sent to the client.
	 * This function performs manual cloning of channel object for
	 * better control of performance and memory usage.
	 *
	 * @param {(int|bool)} lastActiveChannel - Last known active user channel id (needed to control how many messages are sent)
	 *                                         If true, channel is assumed active.
	 * @param {int} lastMessage - Last message id seen by active client to avoid sending duplicates.
	 */
	getFilteredClone(
		lastActiveChannel?: number | boolean,
		lastMessage?: number
	): SharedNetworkChan {
		let msgs: SharedMsg[];

		// If client is reconnecting, only send new messages that client has not seen yet
		if (lastMessage && lastMessage > -1) {
			// When reconnecting, always send up to 100 messages to prevent message gaps on the client
			// See https://github.com/thelounge/thelounge/issues/1883
			msgs = this.messages.filter((m) => m.id > lastMessage).slice(-100);
		} else {
			// If channel is active, send up to 100 last messages, for all others send just 1
			// Client will automatically load more messages whenever needed based on last seen messages
			const messagesToSend =
				lastActiveChannel === true || this.id === lastActiveChannel ? 100 : 1;
			msgs = this.messages.slice(-messagesToSend);
		}

		return {
			id: this.id,
			messages: msgs,
			totalMessages: this.messages.length,
			historyLoaded: this.historyLoaded,
			name: this.name,
			key: this.key,
			topic: this.topic,
			firstUnread: this.firstUnread,
			unread: this.unread,
			highlight: this.highlight,
			muted: this.muted,
			type: this.type,
			state: this.state,
			pinned: this.pinned,

			isOnline: this.isOnline,
			userAway: this.userAway,
			special: this.special,
			data: this.data,
			closed: this.closed,
			num_users: this.num_users,
			groups: this.groups,
		};
		// TODO: funny array mutation below might need to be reproduced
		// static optionalProperties = ["userAway", "special", "data", "closed", "num_users"];
		// return Object.keys(this).reduce((newChannel, prop) => {
		// 	if (Chan.optionalProperties.includes(prop)) {
		// 		if (this[prop] !== undefined || (Array.isArray(this[prop]) && this[prop].length)) {
		// 			newChannel[prop] = this[prop];
		// 		}
		// 	}
	}

	writeUserLog(client: Client, msg: Msg) {
		this.messages.push(msg);
		this.storeMessage(client, msg);
	}

	/**
	 * Writes a message to message storage only, without adding it to the
	 * in-memory history.
	 */
	storeMessage(client: Client, msg: Msg) {
		// Are there any logs enabled
		if (client.messageStorage.length === 0) {
			return;
		}

		// Is this particular message or channel loggable
		if (!msg.isLoggable() || !this.isLoggable()) {
			// Because notices are nasty and can be shown in active channel on the client
			// if there is no open query, we want to always log notices in the sender's name
			if (msg.type === MessageType.NOTICE && msg.showInActive) {
				this.name = msg.from.nick || ""; // TODO: check if || works
			} else {
				return;
			}
		}

		// Find the parent network where this channel is in
		const target = client.find(this.id);

		if (!target) {
			return;
		}

		for (const messageStorage of client.messageStorage) {
			messageStorage.index(target.network, this, msg).catch((e) => log.error(e));
		}
	}

	/**
	 * Pulls this channel's stored history into memory, once per session.
	 *
	 * `lazy` is the first-open path for a channel that existed at startup. It
	 * never asks ZNC for playback: live messages have been flowing since
	 * connect, so a replay would only produce duplicates.
	 */
	loadMessages(client: Client, network: Network, lazy = false) {
		if (this.historyLoaded) {
			return;
		}

		if (!this.isLoggable()) {
			return;
		}

		if (!network.irc) {
			// Network created, but misconfigured
			log.warn(
				`Failed to load messages for ${client.name}, network ${network.name} is not initialized.`
			);
			return;
		}

		// Set before the read resolves so a second open() can't start another one
		this.historyLoaded = true;

		if (!client.messageProvider) {
			if (!lazy && network.irc.network.cap.isEnabled("znc.in/playback")) {
				// if we do have a message provider we might be able to only fetch partial history,
				// so delay the cap in this case.
				requestZncPlayback(this, network, 0);
			}

			return;
		}

		client.messageProvider
			.getMessages(network, this, (maxId) => {
				client.idMsg = Math.max(client.idMsg, maxId + 1);
			})
			.then((stored) => {
				if (stored.length === 0) {
					if (!lazy && network.irc!.network.cap.isEnabled("znc.in/playback")) {
						requestZncPlayback(this, network, 0);
					}

					if (lazy) {
						// Tell clients there is nothing older, they assume
						// there might be until the first load reports back
						client.emit("more", {
							chan: this.id,
							messages: [],
							totalMessages: this.messages.length,
							hasMore: false,
						});
					}

					return;
				}

				// Messages that arrived since startup are already in memory
				// and, being logged, are part of what was just read back.
				const inMemory = new Set(this.messages.map(messageKey));
				// So are the messages a mass event summary in memory stands for
				const covered = client.massEventAggregator.coveredByMassEvent(this);
				const messages = stored.filter((m) => !inMemory.has(messageKey(m)) && !covered(m));

				Helper.unshiftMany(this.messages, messages);

				if (!this.firstUnread) {
					this.firstUnread = this.messages[this.messages.length - 1].id;
				}

				// Only the newest page goes to the client, it pages back
				// through the rest when scrolling up
				const toSend = messages.slice(-100);

				client.emit("more", {
					chan: this.id,
					messages: toSend,
					totalMessages: this.messages.length,
					// Anything older than what is sent here is still reachable,
					// either from memory or straight from storage
					hasMore: messages.length > toSend.length || stored.length >= historyLimit(),
				});

				if (!lazy && network.irc!.network.cap.isEnabled("znc.in/playback")) {
					const from = Math.floor(stored[stored.length - 1].time.getTime() / 1000);

					requestZncPlayback(this, network, from);
				}
			})
			.catch((err: Error) => {
				// Let a later open() try again
				this.historyLoaded = false;
				log.error(`Failed to load messages for ${client.name}: ${err.toString()}`);
			});
	}

	isLoggable() {
		return this.type === ChanType.CHANNEL || this.type === ChanType.QUERY;
	}

	setMuteStatus(muted: boolean) {
		this.muted = !!muted;
	}
}

// Mirrors the row limit SqliteMessageStorage.getMessages() applies
function historyLimit() {
	return Config.values.maxHistory < 0 ? 100000 : Config.values.maxHistory;
}

function requestZncPlayback(channel: Chan, network: Network, from: number) {
	if (!network.irc) {
		throw new Error(
			`requestZncPlayback: no irc field on network "${network.name}", this is a bug`
		);
	}

	network.irc.raw("ZNC", "*playback", "PLAY", channel.name, from.toString());
}

export default Chan;

export type Channel = Chan;
