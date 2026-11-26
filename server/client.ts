import _ from "lodash";
import {UAParser} from "ua-parser-js";
import {v4 as uuidv4} from "uuid";
import crypto from "crypto";
import colors from "chalk";

import log from "./log.js";
import Chan, {ChanConfig} from "./models/chan.js";
import Msg from "./models/msg.js";
import Config from "./config.js";
import {condensedTypes} from "../shared/irc.js";
import {compileHighlightRegex} from "./highlights.js";
import {migrateRenamedSettings} from "../shared/settings.js";
import {messageKey} from "../shared/messageKey.js";
import {MessageType} from "../shared/types/msg.js";
import {SharedMention} from "../shared/types/mention.js";

import inputs from "./plugins/inputs/index.js";
import PublicClient from "./plugins/packages/publicClient.js";
import ThreadedSqliteMessageStorage from "./plugins/messageStorage/sqliteThread.js";
import TextFileMessageStorage from "./plugins/messageStorage/text.js";
import Network, {
	NetworkConfig,
	NetworkFormData,
	NetworkWithIrcFramework,
} from "./models/network.js";
import ClientManager from "./clientManager.js";
import {MessageStorage, MessageProvider} from "./plugins/messageStorage/types.js";
import {StorageCleaner} from "./storageCleaner.js";
import {SearchQuery, SearchResponse} from "../shared/types/storage.js";
import {SharedChan, ChanType} from "../shared/types/chan.js";
import {SharedNetwork} from "../shared/types/network.js";
import {ServerToClientEvents} from "../shared/types/socket-events.js";
import MassEventAggregator from "./plugins/massEventAggregator.js";
import UserIdentLookup from "./plugins/userIdentLookup.js";

// At most this often per channel, browsers are told its user list changed
const USERS_NOTICE_MS = 500;

const events = [
	"away",
	"cap",
	"connection",
	"unhandled",
	"ctcp",
	"chghost",
	"error",
	"help",
	"info",
	"invite",
	"join",
	"kick",
	"list",
	"mode",
	"modelist",
	"motd",
	"message",
	"names",
	"nick",
	"part",
	"quit",
	"sasl",
	"spgroups",
	"spjoin",
	"topic",
	"welcome",
	"whois",
];

type ClientPushSubscription = {
	endpoint: string;
	keys: {
		p256dh: string;
		auth: string;
	};
};

export type UserConfig = {
	log: boolean;
	password: string;
	sessions: {
		[token: string]: {
			lastUse: number;
			ip: string;
			agent: string;
			pushSubscription?: ClientPushSubscription;
		};
	};
	clientSettings: {
		[key: string]: unknown;
	};
	browser?: {
		language?: string;
		ip?: string;
		hostname?: string;
		isSecure?: boolean;
	};
	networks?: NetworkConfig[];
};

class Client {
	awayMessage!: string;
	lastActiveChannel!: number;
	attachedClients!: {
		[socketId: string]: {token: string; openChannel: number};
	};
	config!: UserConfig;
	id: string;
	idMsg!: number;
	idChan!: number;
	name!: string;
	networks!: Network[];
	mentions!: SharedMention[];
	manager!: ClientManager;
	messageStorage!: MessageStorage[];
	highlightRegex!: RegExp | null;
	highlightExceptionRegex!: RegExp | null;
	messageProvider?: MessageProvider;
	// Settles once message ids are past the stored ones, see connect()
	private storedIdsKnown?: Promise<void>;
	massEventAggregator!: MassEventAggregator;
	userIdentLookup = new UserIdentLookup();

	fileHash!: string;
	// Whether settings saved under an old name were moved to the new one on
	// load, so the user file still has to be written with the new names
	private settingsRenamed = false;
	// Channels with a user list notice held back, see usersChanged()
	private usersNotices = new Map<
		number,
		{pending: boolean; timer: ReturnType<typeof setTimeout>}
	>();

	constructor(manager: ClientManager, name?: string, config = {} as UserConfig) {
		this.id = uuidv4();
		_.merge(this, {
			awayMessage: "",
			lastActiveChannel: -1,
			attachedClients: {},
			config: config,
			idChan: 1,
			idMsg: 1,
			name: name,
			networks: [],
			mentions: [],
			manager: manager,
			messageStorage: [],
			highlightRegex: null,
			highlightExceptionRegex: null,
			messageProvider: undefined,
		});

		this.config.log = Boolean(this.config.log);
		this.config.password = String(this.config.password);

		// Initialize mass event aggregator for handling netsplits/mass reconnects
		this.massEventAggregator = new MassEventAggregator(this);

		if (!Config.values.public && this.config.log) {
			if (Config.values.messageStorage.includes("sqlite")) {
				this.messageProvider = new ThreadedSqliteMessageStorage(this.name);

				if (Config.values.storagePolicy.enabled) {
					log.info(
						`Activating storage cleaner. Policy: ${Config.values.storagePolicy.deletionPolicy}. MaxAge: ${Config.values.storagePolicy.maxAgeDays} days`
					);
					const cleaner = new StorageCleaner(this.messageProvider);
					cleaner.start();
				}

				this.messageStorage.push(this.messageProvider);
			}

			if (Config.values.messageStorage.includes("text")) {
				this.messageStorage.push(new TextFileMessageStorage(this.name));
			}

			for (const messageStorage of this.messageStorage) {
				messageStorage.enable().catch((e) => log.error(e));
			}

			// Message ids restart with the server while stored messages keep
			// theirs. History is only read when a channel is opened, so move
			// the counter past everything stored before the first new message.
			this.storedIdsKnown = this.messageProvider
				?.getMaxMessageId()
				.then((maxId) => {
					this.idMsg = Math.max(this.idMsg, maxId + 1);
				})
				.catch((e) => log.error(e));
		}

		if (!_.isPlainObject(this.config.sessions)) {
			this.config.sessions = {};
		}

		if (!_.isPlainObject(this.config.clientSettings)) {
			this.config.clientSettings = {};
		}

		this.settingsRenamed = migrateRenamedSettings(this.config.clientSettings);

		if (!_.isPlainObject(this.config.browser)) {
			this.config.browser = {};
		}

		if (this.config.clientSettings.awayMessage) {
			this.awayMessage = this.config.clientSettings.awayMessage as string;
		}

		this.config.clientSettings.searchEnabled = this.messageProvider !== undefined;

		this.compileCustomHighlights();

		_.forOwn(this.config.sessions, (session) => {
			if (session.pushSubscription) {
				this.registerPushSubscription(session, session.pushSubscription, true);
			}
		});
	}

	connect() {
		if (this.networks.length !== 0) {
			throw new Error(`${this.name} is already connected`);
		}

		(this.config.networks || []).forEach((network) => this.connectToNetwork(network, true));

		// Networks are stored directly in the client object
		// We don't need to keep it in the config object
		delete this.config.networks;

		if (this.name) {
			log.info(`User ${colors.bold(this.name)} loaded`);

			// Networks are created instantly, but to reduce server load on startup
			// We randomize the IRC connections.
			// Channel history is not read here, see Client.open()
			const connectNetworks = () => {
				let delay = this.manager.clients.length * 500;
				this.networks.forEach((network) => {
					setTimeout(() => {
						if (!network.userDisconnected && network.irc) {
							network.irc.connect();
						}
					}, delay);

					delay += 1000 + Math.floor(Math.random() * 1000);
				});
			};

			// Storage answers from its own thread, a moment after start or
			// longer on a slow disk. Until then message ids could repeat
			// stored ones, so the networks wait for it, but not forever.
			if (this.storedIdsKnown) {
				let waited: NodeJS.Timeout | undefined;
				void Promise.race([
					this.storedIdsKnown,
					new Promise<void>((resolve) => {
						waited = setTimeout(() => {
							log.warn(
								`Message storage for ${this.name} is slow to start, connecting anyway`
							);
							resolve();
						}, 10000);
					}),
				]).then(() => {
					clearTimeout(waited);
					connectNetworks();
				});
			} else {
				connectNetworks();
			}

			this.fileHash = this.manager.getDataToSave(this).newHash;

			// The hash above already sees the renamed settings, so it doesn't
			// match the file on disk, which still has the old names. Without
			// this, saving would find nothing changed and skip the write.
			if (this.settingsRenamed) {
				this.settingsRenamed = false;
				this.fileHash = "";
				this.save();
			}
		}
	}

	createChannel(attr: Partial<Chan>) {
		const chan = new Chan(attr);
		chan.id = this.idChan++;

		return chan;
	}

	emit<Ev extends keyof ServerToClientEvents>(
		event: Ev,
		...args: Parameters<ServerToClientEvents[Ev]>
	) {
		if (this.manager !== null) {
			this.manager.sockets.in(this.id).emit(event, ...args);
		}
	}

	/**
	 * Tells the browsers that a channel's user list changed; one showing that
	 * channel then asks for the whole list. A netsplit or a bridge reconnecting
	 * changes it hundreds of times a second, so the first change is announced
	 * straight away and later ones at most once per USERS_NOTICE_MS.
	 */
	usersChanged(chan: Chan) {
		const held = this.usersNotices.get(chan.id);

		if (held) {
			held.pending = true;
			return;
		}

		this.emit("users", {chan: chan.id});
		this.holdUsersNotices(chan.id);
	}

	private holdUsersNotices(chanId: number) {
		const held = {
			pending: false,
			timer: setTimeout(() => {
				this.usersNotices.delete(chanId);

				if (held.pending) {
					this.emit("users", {chan: chanId});
					this.holdUsersNotices(chanId);
				}
			}, USERS_NOTICE_MS),
		};

		this.usersNotices.set(chanId, held);
	}

	find(channelId: number) {
		let network: Network | null = null;
		let chan: Chan | null | undefined = null;

		for (const n of this.networks) {
			chan = _.find(n.channels, {id: channelId});

			if (chan) {
				network = n;
				break;
			}
		}

		if (network && chan) {
			return {network, chan};
		}

		return false;
	}

	networkFromConfig(args: NetworkFormData): Network {
		let channels: Chan[] = [];

		if (Array.isArray(args.channels)) {
			let badChanConf = false;

			args.channels.forEach((chan: ChanConfig) => {
				const type = ChanType[(chan.type || "channel").toUpperCase()];

				if (!chan.name || !type) {
					badChanConf = true;
					return;
				}

				channels.push(
					this.createChannel({
						name: chan.name,
						key: chan.key || "",
						type: type,
						muted: chan.muted,
						pinned: chan.pinned,
					})
				);
			});

			if (badChanConf && this.name) {
				log.warn(
					"User '" +
						this.name +
						"' on network '" +
						(args.name || "") +
						"' has an invalid channel which has been ignored"
				);
			}
			// `join` is kept for backwards compatibility when updating from versions <2.0
			// also used by the "connect" window
		} else if (args.join) {
			channels = (args.join || "")
				.replace(/,/g, " ")
				.split(/\s+/g)
				.map((chan: string) => {
					if (!chan.match(/^[#&!+]/)) {
						chan = `#${chan}`;
					}

					return this.createChannel({
						name: chan,
					});
				});
		}

		// Handle commands - can be string[] or string
		const commands = Array.isArray(args.commands) ? args.commands : [];

		return new Network({
			uuid: args.uuid,
			name: args.name || (Config.values.lockNetwork ? Config.values.defaults.name : "") || "",
			host: args.host || "",
			port: parseInt(String(args.port ?? 6667), 10),
			tls: !!args.tls,
			userDisconnected: !!args.userDisconnected,
			rejectUnauthorized: !!args.rejectUnauthorized,
			password: args.password || "",
			nick: args.nick || "",
			username: args.username || "",
			realname: args.realname || "",
			leaveMessage: args.leaveMessage || "",
			highlights: args.highlights || "",
			highlightExceptions: args.highlightExceptions || "",
			ignoreGlobalHighlights: !!args.ignoreGlobalHighlights,
			sasl: args.sasl || "",
			saslAccount: args.saslAccount || "",
			saslPassword: args.saslPassword || "",
			commands: commands,
			channels: channels,
			ignoreList: args.ignoreList || [],

			proxyEnabled: !!args.proxyEnabled,
			proxyHost: args.proxyHost || "",
			proxyPort: parseInt(String(args.proxyPort ?? 1080), 10),
			proxyUsername: args.proxyUsername || "",
			proxyPassword: args.proxyPassword || "",
		});
	}

	connectToNetwork(args: NetworkFormData, isStartup = false) {
		// Get channel id for lobby before creating other channels for nicer ids
		const lobbyChannelId = this.idChan++;

		const network = this.networkFromConfig(args);

		// Set network lobby channel id
		network.getLobby().id = lobbyChannelId;

		this.networks.push(network);
		this.emit("network", {
			network: network.getFilteredClone(this.lastActiveChannel, -1),
		});

		if (!network.validate(this)) {
			return;
		}

		(network as NetworkWithIrcFramework).createIrcFramework(this);

		// TODO
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		events.forEach(async (plugin) => {
			(await import(`./plugins/irc-events/${plugin}.js`)).default.apply(this, [
				network.irc,
				network,
			]);
		});

		if (network.userDisconnected) {
			network.getLobby().pushMessage(
				this,
				new Msg({
					text: "You have manually disconnected from this network before, use the /connect command to connect again.",
				}),
				true
			);
		} else if (!isStartup) {
			// irc is created in createIrcFramework
			// TODO; fix type
			network.irc!.connect();
		}

		if (!isStartup) {
			this.save();
			network.channels.forEach((channel) => channel.loadMessages(this, network));
		}
	}

	generateToken(callback: (token: string) => void) {
		crypto.randomBytes(64, (err, buf) => {
			if (err) {
				throw err;
			}

			callback(buf.toString("hex"));
		});
	}

	calculateTokenHash(token: string) {
		return crypto.createHash("sha512").update(token).digest("hex");
	}

	updateSession(
		token: string,
		ip: string,
		request: {headers: Record<string, string | string[] | undefined>}
	) {
		const userAgent = request.headers["user-agent"];
		const parser = new UAParser(typeof userAgent === "string" ? userAgent : "");
		const agent = parser.getResult();
		let friendlyAgent = "";

		if (agent.browser.name) {
			friendlyAgent = `${agent.browser.name} ${agent.browser.major || ""}`;
		} else {
			friendlyAgent = "Unknown browser";
		}

		if (agent.os.name) {
			friendlyAgent += ` on ${agent.os.name}`;

			if (agent.os.version) {
				friendlyAgent += ` ${agent.os.version}`;
			}
		}

		this.config.sessions[token] = _.assign(this.config.sessions[token], {
			lastUse: Date.now(),
			ip: ip,
			agent: friendlyAgent,
		});

		this.save();
	}

	setPassword(hash: string, callback: (success: boolean) => void) {
		const oldHash = this.config.password;
		this.config.password = hash;
		this.manager.saveUser(this, (err) => {
			if (err) {
				// If user file fails to write, reset it back
				this.config.password = oldHash;
				return callback(false);
			}

			return callback(true);
		});
	}

	input(data) {
		if (typeof data.text !== "string") {
			return;
		}

		data.text.split("\n").forEach((line) => {
			data.text = line;
			this.inputLine(data);
		});
	}

	inputLine(data) {
		const target = this.find(data.target);

		if (!target) {
			return;
		}

		// Sending a message to a channel is higher priority than merely opening one
		// so that reloading the page will open this channel
		this.lastActiveChannel = target.chan.id;

		let text: string = data.text;

		// This is either a normal message or a command escaped with a leading '/'
		if (text.charAt(0) !== "/" || text.charAt(1) === "/") {
			if (target.chan.type === ChanType.LOBBY) {
				target.chan.pushMessage(
					this,
					new Msg({
						type: MessageType.ERROR,
						text: "Messages can not be sent to lobbies.",
					})
				);
				return;
			}

			text = "say " + text.replace(/^\//, "");
		} else {
			text = text.substring(1);
		}

		const args = text.split(" ");
		const cmd = args?.shift()?.toLowerCase() || "";

		const irc = target.network.irc;
		const connected = irc?.connected;

		const emitFailureDisconnected = () => {
			target.chan.pushMessage(
				this,
				new Msg({
					type: MessageType.ERROR,
					text: "You are not connected to the IRC network, unable to send your command.",
				})
			);
		};

		const plugin = inputs.userInputs.get(cmd);

		if (plugin) {
			if (!connected && !plugin.allowDisconnected) {
				emitFailureDisconnected();
				return;
			}

			plugin.input.apply(this, [target.network, target.chan, cmd, args]);
			return;
		}

		const extPlugin = inputs.pluginCommands.get(cmd);

		if (extPlugin) {
			if (!connected && !extPlugin.allowDisconnected) {
				emitFailureDisconnected();
				return;
			}

			extPlugin.input(
				new PublicClient(this, extPlugin.packageInfo),
				{network: target.network, chan: target.chan},
				cmd,
				args
			);
			return;
		}

		if (!connected) {
			emitFailureDisconnected();
			return;
		}

		// TODO: fix
		irc.raw(text);
	}

	compileCustomHighlights() {
		this.highlightRegex = compileHighlightRegex(this.config.clientSettings.highlights);
		this.highlightExceptionRegex = compileHighlightRegex(
			this.config.clientSettings.highlightExceptions
		);
	}

	async more(data: {
		target: number;
		lastId: number;
		lastTime?: number;
		condensed: boolean;
		beforeTime?: number;
	}) {
		const target = this.find(data.target);

		if (!target) {
			return null;
		}

		const chan = target.chan;
		let messages: Msg[] = [];
		let index = 0;
		let hasMore = false;

		const {batchSize, maxBatchSize} = this.historyBatchSizes();

		// If client requests -1, send last batch of messages
		if (data.lastId < 0) {
			index = chan.messages.length;
		} else {
			// Ids repeat across a channel's history, so the time the client
			// sends along tells which message it means. Clients that don't
			// send one are matched by id alone, as before.
			index = chan.messages.findIndex(
				(val) =>
					val.id === data.lastId &&
					(typeof data.lastTime !== "number" ||
						new Date(val.time).getTime() === data.lastTime)
			);
		}

		// If requested id is not found, an empty array will be sent
		if (index > 0) {
			let startIndex = index;

			if (data.condensed) {
				// Limit to maxBatchSize messages when condensed
				const indexToStop = Math.max(0, index - maxBatchSize);
				let realMessagesLeft = batchSize;

				for (let i = index - 1; i >= indexToStop; i--) {
					startIndex--;

					// Do not count condensed messages towards the batch
					if (condensedTypes.has(chan.messages[i].type)) {
						continue;
					}

					// Count up actual visible messages
					if (--realMessagesLeft === 0) {
						break;
					}
				}
			} else {
				startIndex = Math.max(0, index - batchSize);
			}

			messages = chan.messages.slice(startIndex, index);
			hasMore = startIndex > 0;
		}

		// Memory holds only the newest part of a channel. Once it runs out,
		// keep paging straight from storage. Those rows are not cached here:
		// with the (network, channel, time) index a page costs well under a
		// millisecond, and caching would let scrollback grow without bound.
		if (!hasMore && this.messageProvider?.canProvideMessages() && chan.isLoggable()) {
			try {
				const stored = await this.loadOlderFromStorage(target, messages, data.beforeTime);

				messages = stored.messages.concat(messages);
				hasMore = stored.hasMore;
			} catch (err) {
				log.error(`Failed to load older messages from storage: ${String(err)}`);
			}
		}

		return {
			chan: chan.id,
			messages: messages,
			totalMessages: chan.messages.length,
			hasMore: hasMore,
		};
	}

	private async loadOlderFromStorage(
		target: {network: Network; chan: Chan},
		inMemoryPage: Msg[],
		clientOldestTime?: number
	): Promise<{messages: Msg[]; hasMore: boolean}> {
		const {network, chan} = target;
		const provider = this.messageProvider!;
		const pageSize = this.historyBatchSizes().batchSize;

		// Continue from the oldest message we know the client has or is
		// about to get: this response's page, else whatever the client says
		// its oldest is, else the start of what memory holds.
		const oldest = inMemoryPage[0] || (clientOldestTime ? undefined : chan.messages[0]);
		const anchor = oldest ? new Date(oldest.time).getTime() : (clientOldestTime ?? Date.now());

		const wanted = pageSize - inMemoryPage.length;

		if (wanted <= 0) {
			// The page is already full, only find out whether anything older exists
			const older = await provider.getMessagesBefore(network.uuid, chan.name, anchor, 1);

			return {messages: [], hasMore: older.length > 0};
		}

		const known = new Set(chan.messages.map(messageKey));
		const covered = this.massEventAggregator.coveredByMassEvent(chan);
		const isFresh = (m: Msg) => !known.has(messageKey(m)) && !covered(m);

		// Rows sharing the anchor's millisecond: the client may hold only
		// some of them, and drops the ones it has by id and time. They are
		// read apart from the page itself, as they don't move paging on.
		const atAnchor = (
			await provider.getMessagesBefore(network.uuid, chan.name, anchor, 500, true)
		).filter((m) => new Date(m.time).getTime() === anchor && isFresh(m));

		// The page: up to `wanted` rows strictly older than the anchor. A read
		// with nothing in it to send (rows of a mass event that is shown as
		// its summary) is stepped over, so paging doesn't end there.
		let before = anchor;
		let older: Msg[] = [];
		let full = false;

		for (let reads = 0; reads < 20; reads++) {
			const rows = await provider.getMessagesBefore(network.uuid, chan.name, before, wanted);

			full = rows.length >= wanted;
			older = rows.filter(isFresh);

			if (older.length > 0 || !full) {
				break;
			}

			before = new Date(rows[0].time).getTime();
		}

		return {
			messages: older.concat(atAnchor),
			// A full read means storage may have more. Requiring something
			// older keeps a client from asking for the same page forever.
			hasMore: full && older.length > 0,
		};
	}

	// A page of history holds this many visible messages. When status
	// messages are condensed or hidden on the client they don't count,
	// up to maxBatchSize messages in total.
	private historyBatchSizes() {
		return {batchSize: 100, maxBatchSize: 1000};
	}

	clearHistory(data) {
		const target = this.find(data.target);

		if (!target) {
			return;
		}

		target.chan.messages = [];
		target.chan.unread = 0;
		target.chan.highlight = 0;
		target.chan.firstUnread = 0;

		this.emit("history:clear", {
			target: target.chan.id,
		});

		if (!target.chan.isLoggable()) {
			return;
		}

		for (const messageStorage of this.messageStorage) {
			messageStorage.deleteChannel(target.network, target.chan).catch((e) => log.error(e));
		}
	}

	async search(query: SearchQuery): Promise<SearchResponse> {
		if (!this.messageProvider?.isEnabled) {
			return {
				...query,
				results: [],
			};
		}

		return this.messageProvider.search(query);
	}

	/**
	 * The slice of stored history around a point in time, for jumping to a
	 * message the client doesn't have loaded.
	 */
	async getMessagesAround(data: {target: number; time: number}) {
		const target = this.find(data.target);

		if (!target || !this.messageProvider?.isEnabled || typeof data.time !== "number") {
			return null;
		}

		try {
			const around = await this.messageProvider.getMessagesAround(
				target.network.uuid,
				target.chan.name,
				data.time,
				200
			);

			// The time tells the client which jump this answers
			return {chan: target.chan.id, time: data.time, ...around};
		} catch (err) {
			log.error("Failed to get messages around time:", String(err));
			return null;
		}
	}

	/**
	 * The next page of stored history going forward in time, for a client that
	 * is reading an old slice and scrolling towards the present.
	 */
	async getMessagesAfter(data: {target: number; afterTime: number}) {
		const target = this.find(data.target);

		if (!target || !this.messageProvider?.isEnabled || typeof data.afterTime !== "number") {
			return null;
		}

		// Room for rows sharing the anchor's millisecond, which the client drops
		const limit = this.historyBatchSizes().batchSize + 50;

		try {
			const messages = await this.messageProvider.getMessagesAfter(
				target.network.uuid,
				target.chan.name,
				data.afterTime,
				limit
			);

			return {
				chan: target.chan.id,
				messages,
				// A short read means this page reaches the newest stored message
				hasMore: messages.length >= limit,
			};
		} catch (err) {
			log.error("Failed to get messages after time:", String(err));
			return null;
		}
	}

	open(socketId: string, target: number) {
		// Due to how socket.io works internally, normal events may arrive later than
		// the disconnect event, and because we can't control this timing precisely,
		// process this event normally even if there is no attached client anymore.
		const attachedClient =
			this.attachedClients[socketId] ||
			({} as Record<string, (typeof this.attachedClients)[0]>);

		// Opening a window like settings
		if (target === null) {
			attachedClient.openChannel = -1;
			return;
		}

		const targetNetChan = this.find(target);

		if (!targetNetChan) {
			return;
		}

		targetNetChan.chan.unread = 0;
		targetNetChan.chan.highlight = 0;

		if (targetNetChan.chan.messages.length > 0) {
			targetNetChan.chan.firstUnread =
				targetNetChan.chan.messages[targetNetChan.chan.messages.length - 1].id;
		}

		// First open of a channel this session reads its stored history
		targetNetChan.chan.loadMessages(this, targetNetChan.network, true);

		attachedClient.openChannel = targetNetChan.chan.id;
		this.lastActiveChannel = targetNetChan.chan.id;

		this.emit("open", targetNetChan.chan.id);
	}

	sortChannels(netid: SharedNetwork["uuid"], order: SharedChan["id"][]) {
		const network = _.find(this.networks, {uuid: netid});

		if (!network) {
			return;
		}

		network.channels.sort((a, b) => {
			// Always sort lobby to the top regardless of what the client has sent
			// Because there's a lot of code that presumes channels[0] is the lobby
			if (a.type === ChanType.LOBBY) {
				return -1;
			} else if (b.type === ChanType.LOBBY) {
				return 1;
			}

			return order.indexOf(a.id) - order.indexOf(b.id);
		});
		this.save();
		// Sync order to connected clients
		this.emit("sync_sort:channels", {
			network: network.uuid,
			order: network.channels.map((obj) => obj.id),
		});
	}

	sortNetworks(order: SharedNetwork["uuid"][]) {
		this.networks.sort((a, b) => order.indexOf(a.uuid) - order.indexOf(b.uuid));
		this.save();
		// Sync order to connected clients
		this.emit("sync_sort:networks", {
			order: this.networks.map((obj) => obj.uuid),
		});
	}

	names(data: {target: number}) {
		const target = this.find(data.target);

		if (!target) {
			return;
		}

		this.emit("names", {
			id: target.chan.id,
			users: target.chan.getSortedUsers(target.network.irc),
		});
	}

	part(network: Network, chan: Chan) {
		network.channels = _.without(network.channels, chan);
		this.mentions = this.mentions.filter((msg) => !(msg.chanId === chan.id));
		this.massEventAggregator.cleanup(chan.id);
		chan.destroy();
		this.save();
		this.emit("part", {
			chan: chan.id,
		});
	}

	quit(signOut?: boolean) {
		const sockets = this.manager.sockets.sockets;
		const room = sockets.adapter.rooms.get(this.id);

		if (room) {
			for (const user of room) {
				const socket = sockets.sockets.get(user);

				if (socket) {
					if (signOut) {
						socket.emit("sign-out");
					}

					socket.disconnect();
				}
			}
		}

		this.userIdentLookup.clear();

		this.usersNotices.forEach(({timer}) => clearTimeout(timer));
		this.usersNotices.clear();

		this.networks.forEach((network) => {
			network.quit();
			network.destroy(this);
		});

		for (const messageStorage of this.messageStorage) {
			messageStorage.close().catch((e) => log.error(e));
		}
	}

	clientAttach(socketId: string, token: string) {
		if (this.awayMessage && _.size(this.attachedClients) === 0) {
			this.networks.forEach((network) => {
				// Only remove away on client attachment if
				// there is no away message on this network
				if (network.irc && !network.awayMessage) {
					network.irc.raw("AWAY");
				}
			});
		}

		const openChannel = this.lastActiveChannel;
		this.attachedClients[socketId] = {token, openChannel};
	}

	clientDetach(socketId: string) {
		delete this.attachedClients[socketId];

		if (this.awayMessage && _.size(this.attachedClients) === 0) {
			this.networks.forEach((network) => {
				// Only set away on client deattachment if
				// there is no away message on this network
				if (network.irc && !network.awayMessage) {
					network.irc.raw("AWAY", this.awayMessage);
				}
			});
		}
	}

	registerPushSubscription(
		session: {
			lastUse: number;
			ip: string;
			agent: string;
			pushSubscription?: ClientPushSubscription;
		},
		subscription: PushSubscriptionJSON,
		noSave = false
	) {
		if (
			!_.isPlainObject(subscription) ||
			typeof subscription.endpoint !== "string" ||
			!/^https?:\/\//.test(subscription.endpoint) ||
			!_.isPlainObject(subscription.keys) ||
			!subscription.keys || // TS compiler doesn't understand isPlainObject
			typeof subscription.keys.p256dh !== "string" ||
			typeof subscription.keys.auth !== "string"
		) {
			session.pushSubscription = undefined;
			return;
		}

		const data = {
			endpoint: subscription.endpoint,
			keys: {
				p256dh: subscription.keys.p256dh,
				auth: subscription.keys.auth,
			},
		};

		session.pushSubscription = data;

		if (!noSave) {
			this.save();
		}

		return data;
	}

	unregisterPushSubscription(token: string) {
		this.config.sessions[token].pushSubscription = undefined;
		this.save();
	}

	save = _.debounce(
		function SaveClient(this: Client) {
			if (Config.values.public) {
				return;
			}

			this.manager.saveUser(this);
		},
		5000,
		{maxWait: 20000}
	);
}

export default Client;

// TODO: this should exist elsewhere?
export type IrcEventHandler = (
	this: Client,
	irc: NetworkWithIrcFramework["irc"],
	network: NetworkWithIrcFramework
) => void;
