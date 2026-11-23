// The storage thread: owns every user's SQLite database, so that reading and
// writing them, however long the disk takes, never holds up the server's own
// thread. sqliteThread.ts starts it and talks to it.
import {parentPort} from "node:worker_threads";
import log from "../../log.js";
import SqliteMessageStorage, {StoredRow} from "./sqlite.js";
import type {DeletionRequest} from "./types.js";
import type {SearchQuery} from "../../../shared/types/storage.js";

export type StorageRequest = {
	// Set when the server waits for the answer
	id?: number;
	store: number;
	method: keyof typeof methods;
	args: unknown[];
};

export type StorageReply =
	| {id: number; ok: true; value: unknown}
	| {id: number; ok: false; error: {message: string; stack?: string}};

const stores = new Map<number, SqliteMessageStorage>();

async function open(store: number, userName: string, logsPath: string) {
	const storage = new SqliteMessageStorage(userName);
	stores.set(store, storage);
	await storage.enable(logsPath);
	return storage.isEnabled;
}

async function close(store: number) {
	const storage = stores.get(store);
	stores.delete(store);
	await storage?.close();
}

// Closes every database, storing what is still queued, before the server
// exits
async function shutdown() {
	const all = Array.from(stores.values());
	stores.clear();
	await Promise.allSettled(all.map((storage) => storage.close()));
}

const methods = {
	open,
	close,
	shutdown,
	indexRow: (store: number, row: StoredRow) => get(store).indexRow(row),
	deleteChannel: (store: number, networkUuid: string, channelName: string) =>
		get(store).deleteChannel({uuid: networkUuid}, {name: channelName}),
	getChannelHistory: (store: number, networkUuid: string, channelName: string, limit: number) =>
		get(store).getChannelHistory(networkUuid, channelName, limit),
	getMaxMessageId: (store: number) => get(store).getMaxMessageId(),
	search: (store: number, query: SearchQuery) => get(store).search(query),
	getMessagesBefore: (
		store: number,
		...args: Parameters<SqliteMessageStorage["getMessagesBefore"]>
	) => get(store).getMessagesBefore(...args),
	getMessagesAround: (
		store: number,
		...args: Parameters<SqliteMessageStorage["getMessagesAround"]>
	) => get(store).getMessagesAround(...args),
	getMessagesAfter: (
		store: number,
		...args: Parameters<SqliteMessageStorage["getMessagesAfter"]>
	) => get(store).getMessagesAfter(...args),
	deleteMessages: (store: number, req: DeletionRequest) => get(store).deleteMessages(req),
};

function get(store: number): SqliteMessageStorage {
	const storage = stores.get(store);

	if (!storage) {
		throw new Error("This message storage is closed");
	}

	return storage;
}

// Every failure, also one thrown right away, ends up as a rejected promise
function handle(req: StorageRequest): Promise<unknown> {
	return Promise.resolve().then(() => {
		const method = methods[req.method] as (store: number, ...args: unknown[]) => unknown;

		if (typeof method !== "function") {
			throw new Error(`Unknown storage method ${String(req.method)}`);
		}

		return method(req.store, ...req.args);
	});
}

parentPort!.on("message", (req: StorageRequest) => {
	handle(req).then(
		(value) => {
			if (req.id !== undefined) {
				parentPort!.postMessage({id: req.id, ok: true, value} satisfies StorageReply);
			}
		},
		(err: unknown) => {
			const error =
				err instanceof Error
					? {message: err.message, stack: err.stack}
					: {message: String(err)};

			if (req.id !== undefined) {
				parentPort!.postMessage({id: req.id, ok: false, error} satisfies StorageReply);
			} else {
				// Nobody waits on a stored message, so report it here
				log.error(error.stack ?? error.message);
			}
		}
	);
});
