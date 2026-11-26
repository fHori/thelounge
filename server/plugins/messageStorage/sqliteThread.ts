// SQLite message storage, run on a thread of its own.
//
// better-sqlite3 is synchronous: on the server's thread every query and every
// commit holds up everything else for as long as the disk takes. On a busy
// hard disk that is seconds to minutes, and the server stops answering
// browsers and IRC alike. Here all users' databases live on one storage
// thread (sqliteWorker.ts), and a slow disk only delays storage.
import {Worker} from "node:worker_threads";
import log from "../../log.js";
import {scrub} from "../../diagnostics.js";
import Config from "../../config.js";
import Msg, {Message} from "../../models/msg.js";
import type {Channel} from "../../models/chan.js";
import type Network from "../../models/network.js";
import type {DeletionRequest, MessageProvider} from "./types.js";
import type {
	DatabaseStats,
	DiskProbe,
	SearchIndexState,
	SearchLogEntry,
	SearchQuery,
	SearchResponse,
	SearchStats,
	StorageDiagnostics,
} from "../../../shared/types/storage.js";
import {toStoredRow, historyLimit, maxMessageId} from "./sqlite.js";
import type {StorageReply, StorageRequest} from "./sqliteWorker.js";

type Pending = {resolve: (value: unknown) => void; reject: (err: Error) => void};

class StorageThread {
	private worker: Worker;
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private stopping = false;

	constructor(private onExit: (thread: StorageThread) => void) {
		this.worker = new Worker(new URL("./sqliteWorker.js", import.meta.url));

		// Only kept running by calls waiting for an answer, see call()
		this.worker.unref();

		this.worker.on("message", (reply: StorageReply) => this.settle(reply));

		this.worker.on("error", (err) => {
			log.error(`The message storage thread failed: ${err.stack ?? String(err)}`);
		});

		this.worker.on("exit", (code) => {
			if (!this.stopping) {
				log.error(
					`The message storage thread stopped (exit code ${code}); history and search are unavailable until The Lounge restarts`
				);
			}

			const err = new Error("The message storage thread has stopped");

			for (const call of this.pending.values()) {
				call.reject(err);
			}

			this.pending.clear();
			this.onExit(this);
		});
	}

	call<T>(store: number, method: StorageRequest["method"], ...args: unknown[]): Promise<T> {
		const id = this.nextId++;

		return new Promise<T>((resolve, reject) => {
			if (this.pending.size === 0) {
				this.worker.ref();
			}

			this.pending.set(id, {resolve: (value) => resolve(value as T), reject});
			this.post({id, store, method, args});
		});
	}

	// Calls waiting for an answer
	get waiting() {
		return this.pending.size;
	}

	// For calls nobody waits on. Errors are logged by the storage thread.
	send(store: number, method: StorageRequest["method"], ...args: unknown[]) {
		this.post({store, method, args});
	}

	async stop() {
		if (this.stopping) {
			return;
		}

		try {
			await this.call(0, "shutdown");
		} finally {
			this.stopping = true;
			await this.worker.terminate();
		}
	}

	private post(req: StorageRequest) {
		this.worker.postMessage(req);
	}

	private settle(reply: StorageReply) {
		const call = this.pending.get(reply.id);

		if (!call) {
			return;
		}

		this.pending.delete(reply.id);

		if (this.pending.size === 0) {
			this.worker.unref();
		}

		if (reply.ok) {
			call.resolve(reply.value);
		} else {
			const err = new Error(reply.error.message);

			if (reply.error.stack) {
				err.stack = reply.error.stack;
			}

			call.reject(err);
		}
	}
}

let thread: StorageThread | null = null;
let nextStore = 1;
const open = new Set<ThreadedSqliteMessageStorage>();

function getThread(): StorageThread {
	if (!thread) {
		thread = new StorageThread((exited) => {
			if (thread === exited) {
				thread = null;
			}

			// Their databases are gone with the thread
			for (const storage of open) {
				storage.isEnabled = false;
			}

			open.clear();
		});
	}

	return thread;
}

/**
 * Closes every database, storing what is still queued, and ends the storage
 * thread. For shutting the server down.
 */
export async function stopStorageThread() {
	if (thread) {
		await thread.stop();
	}
}

// How many searches diagnostics keep per user
const searchLogSize = 20;

// Searches slower than this are logged, for those who only see the log
const slowSearchMs = 2000;

// How long diagnostics wait for the storage thread. Longer means it's busy,
// which is worth saying rather than waiting for.
export const diagnosticsTimeout = {ms: 2000};

// The promise's value, or null if it takes longer than `ms`
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: NodeJS.Timeout;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ms);
	});

	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const searchFilters = ["from", "datebefore", "dateafter"];

// What diagnostics keep of a search: never the term, only its shape
export function searchShape(
	query: SearchQuery
): Pick<SearchLogEntry, "termLength" | "filters" | "scope"> {
	const words = query.searchTerm.split(" ");
	const filters = searchFilters.filter((name) => words.some((w) => w.startsWith(`${name}:`)));
	const term = words.filter((w) => !searchFilters.some((name) => w.startsWith(`${name}:`)));

	return {
		termLength: Array.from(term.join(" ")).length,
		filters,
		scope: query.channelName ? "channel" : query.networkUuid ? "network" : "all",
	};
}

// Messages come back from the storage thread as plain objects
function toMsg(message: object): Msg {
	return new Msg(message);
}

/**
 * A user's SQLite message storage, kept on the storage thread. Same interface
 * as SqliteMessageStorage, which does the work there.
 */
export default class ThreadedSqliteMessageStorage implements MessageProvider {
	isEnabled = false;
	private store = nextStore++;
	private thread: StorageThread | null = null;
	// Why the database didn't open, for diagnostics
	private enableError: string | null = null;
	// The last searches, newest first, for diagnostics
	private searchLog: SearchLogEntry[] = [];

	constructor(private userName: string) {}

	async enable() {
		this.thread = getThread();
		open.add(this);

		try {
			const enabled = await this.thread.call<boolean>(
				this.store,
				"open",
				this.userName,
				Config.getUserLogsPath()
			);

			// Unless it was closed while opening
			this.isEnabled = enabled && open.has(this);
			this.enableError = null;
		} catch (err) {
			this.isEnabled = false;
			this.enableError = err instanceof Error ? err.message : String(err);
			throw err;
		}
	}

	async close() {
		const wasOpen = open.delete(this);
		this.isEnabled = false;

		if (wasOpen && this.thread) {
			await this.thread.call(this.store, "close");
		}
	}

	canProvideMessages() {
		return this.isEnabled;
	}

	// Like SqliteMessageStorage, a storage that isn't open stores nothing
	// and has nothing to show

	index(network: Network, channel: Channel, msg: Msg) {
		// Turned into its row here, while the message is as it was sent
		this.openThread()?.send(
			this.store,
			"indexRow",
			toStoredRow(network.uuid, channel.name, msg)
		);
		return Promise.resolve();
	}

	async deleteChannel(network: Network, channel: Channel) {
		await this.openThread()?.call(this.store, "deleteChannel", network.uuid, channel.name);
	}

	async getMessages(
		network: Network,
		channel: Channel,
		ensureIdAbove: (maxId: number) => void
	): Promise<Msg[]> {
		const messages = await this.read<Message[]>(
			[],
			"getChannelHistory",
			network.uuid,
			channel.name,
			historyLimit(Config.values.maxHistory)
		);
		const loaded = messages.map(toMsg);

		ensureIdAbove(maxMessageId(loaded));
		return loaded;
	}

	getMaxMessageId() {
		return this.read<number>(0, "getMaxMessageId");
	}

	async search(query: SearchQuery): Promise<SearchResponse> {
		const start = performance.now();
		const {response, stats} = await this.read<{
			response: SearchResponse;
			stats: SearchStats | null;
		}>({response: {...query, results: []}, stats: null}, "searchWithStats", query);

		if (stats) {
			const entry: SearchLogEntry = {
				...stats,
				at: Date.now(),
				...searchShape(query),
				totalMs: performance.now() - start,
			};
			this.searchLog.unshift(entry);
			this.searchLog.length = Math.min(this.searchLog.length, searchLogSize);

			if (entry.totalMs > slowSearchMs) {
				log.warn(
					`Slow search for ${this.userName}: ${Math.round(entry.totalMs)} ms, ` +
						`${entry.strategy}${entry.reason ? ` (${entry.reason})` : ""}, ` +
						`query ${Math.round(entry.queryMs)} ms, ${entry.termLength} chars, ` +
						`${entry.results} results. Details in Help → Diagnostics.`
				);
			}
		}

		return {...response, results: response.results.map(toMsg)};
	}

	/**
	 * What search and the storage thread are up to, for finding out why
	 * search is slow. `probeDisk` also times reads from the database file.
	 */
	async diagnostics(probeDisk = false): Promise<StorageDiagnostics> {
		const result: StorageDiagnostics = {
			storage: "sqlite",
			open: this.isEnabled,
			searches: this.searchLog,
		};

		if (this.enableError !== null) {
			result.error = scrub(this.enableError, this.userName);
		}

		const running = this.openThread();

		if (!running || !this.isEnabled) {
			return result;
		}

		const waiting = running.waiting;
		const start = performance.now();

		// Calls are answered in order, so a busy thread answers none of these
		// until it's done; say so instead of keeping the page waiting
		if ((await within(running.call(this.store, "ping"), diagnosticsTimeout.ms)) === null) {
			result.thread = {pingMs: null, waiting};
			return result;
		}

		const pingMs = performance.now() - start;
		const wide = await running.call<{stores: number; buildingIndex: number}>(
			this.store,
			"threadStats"
		);
		result.thread = {pingMs, waiting, ...wide};

		const stats = await running.call<{
			database: DatabaseStats;
			index: SearchIndexState;
			disk?: DiskProbe;
		}>(this.store, "diagnostics", probeDisk);

		return {...result, ...stats};
	}

	async getMessagesBefore(
		networkUuid: string,
		channelName: string,
		beforeTime: number,
		limit: number,
		inclusive = false
	) {
		const messages = await this.read<Message[]>(
			[],
			"getMessagesBefore",
			networkUuid,
			channelName,
			beforeTime,
			limit,
			inclusive
		);

		return messages.map(toMsg);
	}

	async getMessagesAround(
		networkUuid: string,
		channelName: string,
		targetTime: number,
		limit = 200
	) {
		const around = await this.read<{
			messages: Message[];
			hasMoreBefore: boolean;
			hasMoreAfter: boolean;
		}>(
			{messages: [], hasMoreBefore: false, hasMoreAfter: false},
			"getMessagesAround",
			networkUuid,
			channelName,
			targetTime,
			limit
		);

		return {...around, messages: around.messages.map(toMsg)};
	}

	async getMessagesAfter(
		networkUuid: string,
		channelName: string,
		afterTime: number,
		limit: number
	) {
		const messages = await this.read<Message[]>(
			[],
			"getMessagesAfter",
			networkUuid,
			channelName,
			afterTime,
			limit
		);

		return messages.map(toMsg);
	}

	deleteMessages(req: DeletionRequest) {
		return this.read<number>(0, "deleteMessages", req);
	}

	private read<T>(empty: T, method: StorageRequest["method"], ...args: unknown[]): Promise<T> {
		const running = this.openThread();
		return running ? running.call<T>(this.store, method, ...args) : Promise.resolve(empty);
	}

	// The thread this storage was opened on, while it is open there
	private openThread(): StorageThread | null {
		return open.has(this) ? this.thread : null;
	}
}
