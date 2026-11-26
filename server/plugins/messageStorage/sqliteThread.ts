// SQLite message storage, run on a thread of its own.
//
// better-sqlite3 is synchronous: on the server's thread every query and every
// commit holds up everything else for as long as the disk takes. On a busy
// hard disk that is seconds to minutes, and the server stops answering
// browsers and IRC alike. Here all users' databases live on one storage
// thread (sqliteWorker.ts), and a slow disk only delays storage.
import {Worker} from "node:worker_threads";
import log from "../../log.js";
import Config from "../../config.js";
import Msg, {Message} from "../../models/msg.js";
import type {Channel} from "../../models/chan.js";
import type Network from "../../models/network.js";
import type {DeletionRequest, MessageProvider} from "./types.js";
import type {
	SearchCursor,
	SearchQuery,
	SearchRequest,
	SearchResponse,
} from "../../../shared/types/storage.js";
import {
	toStoredRow,
	historyLimit,
	maxMessageId,
	searchPageSize,
	sortNewestFirst,
} from "./sqlite.js";
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

// How many index hits (lookup) or messages (scan) a search batch looks at.
// The first lookup batch is small so the first results show at once even
// on a slow disk; later ones are sized to take about targetMs. Exported for
// tests.
export const searchBatchRows = {
	lookup: {start: 25, min: 10, max: 2000, targetMs: 30},
	scan: {start: 200, min: 50, max: 20000, targetMs: 30},
};

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
		} catch (err) {
			this.isEnabled = false;
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

	/**
	 * Searches newest first a batch at a time, handing each batch's results
	 * to `onResults` as soon as it has them, until a page is full or nothing
	 * older is left. Each batch is its own call to the storage thread, so
	 * other work goes on in between, and `cancelled` is asked before each:
	 * a search nobody waits for any more stops there. Resolves with the
	 * cursor older results go on from, null when there are none.
	 */
	async searchStream(
		request: Omit<SearchRequest, "id">,
		onResults: (results: Msg[]) => void,
		cancelled: () => boolean = () => false
	): Promise<SearchCursor | null> {
		const running = this.openThread();

		if (!running) {
			return null;
		}

		let cursor = request.cursor;
		let kind: SearchCursor["kind"] = cursor?.kind ?? "lookup";
		let rows = searchBatchRows[kind].start;
		let results = 0;
		let examined = 0;

		for (;;) {
			const batchStart = performance.now();
			const batch = await running.call<{
				results: Message[];
				cursor: SearchCursor | null;
				examined: number;
			}>(this.store, "searchBatch", {...request, cursor, rows});

			examined += batch.examined;

			if (batch.results.length) {
				results += batch.results.length;
				onResults(batch.results.map(toMsg));
			}

			cursor = batch.cursor;

			if (!cursor || results >= searchPageSize || cancelled()) {
				return cursor;
			}

			// The first batch decides: the index may not help this search
			if (cursor.kind !== kind) {
				kind = cursor.kind;
				rows = searchBatchRows[kind].start;
				continue;
			}

			// Size the next batch to take about as long as targetMs, but no
			// bigger than what likely fills the page at the rate rows matched
			// so far, so a page doesn't grow far past its size
			const limits = searchBatchRows[kind];
			const took = Math.max(1, performance.now() - batchStart);
			const rate = results / examined;
			const needed = rate > 0 ? (searchPageSize - results) / rate : limits.max;
			rows = Math.round(
				Math.max(
					limits.min,
					Math.min(
						limits.max,
						needed,
						Math.max((rows * limits.targetMs) / took, rows / 2)
					)
				)
			);
		}
	}

	/**
	 * A page of results at once, oldest first, for the MessageProvider
	 * interface: the newest page, or the next older ones for offset 100,
	 * 200 and so on.
	 */
	async search(query: SearchQuery): Promise<SearchResponse> {
		const found: Msg[] = [];
		let cursor: SearchCursor | null = null;

		do {
			cursor = await this.searchStream(
				{
					searchTerm: query.searchTerm,
					networkUuid: query.networkUuid,
					channelName: query.channelName,
					cursor,
				},
				(results) => found.push(...results)
			);
		} while (cursor && found.length < query.offset + searchPageSize);

		const page = sortNewestFirst(found).slice(query.offset, query.offset + searchPageSize);
		return {...query, results: page.reverse()};
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
