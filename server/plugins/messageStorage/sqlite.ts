import Database from "better-sqlite3";

import log from "../../log.js";
import path from "path";
import fs from "fs/promises";
import Config from "../../config.js";
import Msg, {Message} from "../../models/msg.js";
import Chan, {Channel} from "../../models/chan.js";
import Helper from "../../helper.js";
import type {SearchableMessageStorage, DeletionRequest} from "./types.js";
import Network from "../../models/network.js";
import type {
	DatabaseStats,
	DiskProbe,
	SearchBatchQuery,
	SearchBatchStats,
	SearchCursor,
	SearchIndexState,
	SearchQuery,
	SearchResponse,
	SearchScanReason,
} from "../../../shared/types/storage.js";
import {MessageType} from "../../../shared/types/msg.js";

type Migration = {version: number; stmts: string[]};

// Search index over the text of `type = 'message'` rows, keyed by messages.id.
//
// - trigram: finds arbitrary substrings, which is what search has always done.
// - detail=none + contentless: the index only has to answer "which rows contain
//   all of these trigrams". Every hit is checked against the real text in
//   `messages` afterwards, so neither token positions nor a second copy of the
//   text are stored. This is about a fifth of the size of the messages table.
// - contentless_delete: lets rows be removed again without the original text.
const ftsTable =
	"CREATE VIRTUAL TABLE messages_fts USING fts5(text, tokenize='trigram', detail=none, content='', contentless_delete=1)";

// Deletes happen in several places (clear history, storage cleaner), a trigger
// covers all of them. Inserts go through flushBatch(), which writes the index
// row itself: doing that from a trigger is roughly 8x slower per message.
const ftsDeleteTrigger =
	"CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages WHEN old.type = 'message' BEGIN DELETE FROM messages_fts WHERE rowid = old.id; END";

// Marks every message stored so far as still to be indexed: ids from
// fts_backfill_next up to fts_backfill_end. Newer messages are indexed when
// they are stored. Both options are removed once the index is complete.
const ftsBackfillStmts = [
	"INSERT OR REPLACE INTO options (name, value) VALUES ('fts_backfill_next', '0')",
	"INSERT OR REPLACE INTO options (name, value) SELECT 'fts_backfill_end', CAST(coalesce(max(id), 0) AS TEXT) FROM messages",
];

// How long one step of the background index build may hold the server up.
// Steps are sized to fit it, and the server gets a turn in between.
const ftsBackfillStepMs = 40;

// The same for deleting the history of a cleared channel. A single DELETE of
// a channel with 1.5M messages held the server up for 25 to 36 seconds, most
// of it spent taking each row out of the search index.
const clearStepMs = 20;

// SQLite's defaults for the index's merge options, see clearHistoryStep()
const ftsDefaultAutomerge = 4;
const ftsDefaultDeleteMerge = 10;

// Results per page of a search
export const searchPageSize = 100;

// Starts at no cursor: newer than anything stored
const newestCursor = Number.MAX_SAFE_INTEGER;
type Rollback = {version: number; rollback_forbidden?: boolean; stmts: string[]};

export const currentSchemaVersion = 1794820000000; // use `new Date().getTime()`

// Desired schema, adapt to the newest version and add migrations to the array below
const schema = [
	"CREATE TABLE options (name TEXT, value TEXT, CONSTRAINT name_unique UNIQUE (name))",
	"CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, network TEXT, channel TEXT, time INTEGER, type TEXT, msg TEXT)",
	`CREATE TABLE migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL UNIQUE,
        rollback_forbidden INTEGER DEFAULT 0 NOT NULL
    )`,
	`CREATE TABLE rollback_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        migration_id INTEGER NOT NULL REFERENCES migrations ON DELETE CASCADE,
        step INTEGER NOT NULL,
        statement TEXT NOT NULL
    )`,
	// Covers both "all rows of a channel" lookups and time-ordered history paging.
	// Without the trailing time column every history query has to sort the whole channel.
	"CREATE INDEX network_channel_time ON messages (network, channel, time)",
	"CREATE INDEX time ON messages (time)",
	"CREATE INDEX msg_type_idx on messages (type)", // needed for efficient storageCleaner queries
	ftsTable,
	ftsDeleteTrigger,
];

// the migrations will be executed in an exclusive transaction as a whole
// add new migrations to the end, with the version being the new 'currentSchemaVersion'
// write a corresponding down migration into rollbacks
export const migrations: Migration[] = [
	{
		version: 1672236339873,
		stmts: [
			"CREATE TABLE messages_new (id INTEGER PRIMARY KEY AUTOINCREMENT, network TEXT, channel TEXT, time INTEGER, type TEXT, msg TEXT)",
			"INSERT INTO messages_new(network, channel, time, type, msg) select network, channel, time, type, msg from messages order by time asc",
			"DROP TABLE messages",
			"ALTER TABLE messages_new RENAME TO messages",
			"CREATE INDEX network_channel ON messages (network, channel)",
			"CREATE INDEX time ON messages (time)",
		],
	},
	{
		version: 1679743888000,
		stmts: [
			`CREATE TABLE IF NOT EXISTS migrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                version INTEGER NOT NULL UNIQUE,
                rollback_forbidden INTEGER DEFAULT 0 NOT NULL
            )`,
			`CREATE TABLE IF NOT EXISTS rollback_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                migration_id INTEGER NOT NULL REFERENCES migrations ON DELETE CASCADE,
                step INTEGER NOT NULL,
                statement TEXT NOT NULL
            )`,
		],
	},
	{
		version: 1703322560448,
		stmts: ["CREATE INDEX msg_type_idx on messages (type)"],
	},
	{
		// Stock The Lounge 4.5's migration, taken over as is so that a
		// database it has already upgraded continues from here. Replaces
		// network_channel, of which it is a strict prefix, and also covers
		// the time ordering of history queries.
		version: 1780272000000,
		stmts: [
			"CREATE INDEX IF NOT EXISTS network_channel_time ON messages (network, channel, time)",
			"DROP INDEX IF EXISTS network_channel",
		],
	},
	{
		// This fork's own version of the migration above, from before stock
		// had it. It is kept so databases that already ran it see no gap, and
		// does nothing on top of it.
		version: 1794816000000,
		stmts: [
			"CREATE INDEX IF NOT EXISTS network_channel_time ON messages (network, channel, time)",
			"DROP INDEX IF EXISTS network_channel",
		],
	},
	{
		version: 1794820000000,
		stmts: [
			ftsTable,
			// The existing messages are indexed afterwards, in the background
			// (see buildSearchIndexStep): doing it here took about 5 seconds
			// per million messages, with the whole server waiting. Messages
			// stored from now on are indexed as they come in.
			...ftsBackfillStmts,
			ftsDeleteTrigger,
		],
	},
];

// down migrations need to restore the state of the prior version.
// rollback can be disallowed by adding rollback_forbidden: true to it
export const rollbacks: Rollback[] = [
	{
		version: 1672236339873,
		stmts: [], // changes aren't visible, left empty on purpose
	},
	{
		version: 1679743888000,
		stmts: [], // here we can't drop the tables, as we use them in the code, so just leave those in
	},
	{
		version: 1703322560448,
		stmts: ["drop INDEX msg_type_idx"],
	},
	{
		version: 1780272000000,
		stmts: [
			"DROP INDEX IF EXISTS network_channel_time",
			"CREATE INDEX IF NOT EXISTS network_channel ON messages (network, channel)",
		],
	},
	{
		// The index is undone by 1780272000000's rollback above. Databases
		// that ran this migration before that one existed have its old
		// rollback steps stored, which do the same thing.
		version: 1794816000000,
		stmts: [],
	},
	{
		version: 1794820000000,
		stmts: [
			"DROP TRIGGER messages_fts_delete",
			"DROP TABLE messages_fts",
			"DELETE FROM options WHERE name IN ('fts_backfill_next', 'fts_backfill_end')",
		],
	},
];

class Deferred {
	resolve!: () => void;
	promise: Promise<void>;

	constructor() {
		this.promise = new Promise((resolve) => {
			this.resolve = resolve;
		});
	}
}

// A channel whose history was cleared: its rows with ids up to `upto` are
// hidden at once and deleted a step at a time afterwards. Ids only grow
// (AUTOINCREMENT), so anything stored after the clear is above `upto`.
type HistoryClear = {network: string; channel: string; upto: number};

const clearKey = (network: string, channel: string) => `${network}\n${channel}`;

// A message as it is stored, see toStoredRow()
export type StoredRow = {
	network: string;
	channel: string;
	time: number;
	type: string;
	msg: string;
	// What search should find this row by, null if it isn't searchable
	searchText: string | null;
};

/**
 * The row a message is stored as. Kept apart from storing it so the server
 * can do this while it still holds the message, and hand the storage thread
 * nothing but plain data.
 */
export function toStoredRow(networkUuid: string, channelName: string, msg: Msg): StoredRow {
	const clonedMsg = Object.keys(msg).reduce((newMsg, prop) => {
		// previews are not stored because storage is cleared on lounge restart
		// type and time are stored in a separate column
		// id IS now stored so it can be retrieved consistently
		if (prop !== "previews" && prop !== "type" && prop !== "time") {
			newMsg[prop] = msg[prop];
		}

		return newMsg;
	}, {});

	return {
		network: networkUuid,
		channel: channelName.toLowerCase(),
		time: msg.time.getTime(),
		type: msg.type,
		msg: JSON.stringify(clonedMsg),
		searchText:
			msg.type === MessageType.MESSAGE && typeof msg.text === "string" ? msg.text : null,
	};
}

class SqliteMessageStorage implements SearchableMessageStorage {
	isEnabled: boolean;
	database!: Database.Database;
	initDone: Deferred;
	userName: string;

	// Message batching for improved write performance
	private batchQueue: StoredRow[] = [];
	private batchSize = 50; // Flush after 50 messages
	private batchTimeout = 1000; // Flush after 1 second
	private batchTimer: NodeJS.Timeout | null = null;
	private insertStmt: Database.Statement | null = null;
	private ftsInsertStmt: Database.Statement | null = null;

	// False while existing messages are still being added to the search
	// index in the background. Search reads every message until then.
	searchIndexReady = true;
	// Why the background build stopped, if it failed
	private searchIndexError: string | null = null;
	// The background build waits until then: a search is going on, and it
	// goes first
	private searchingUntil = 0;
	private finishing = false;
	private backfill: {
		timer: NodeJS.Timeout | null;
		rows: number; // rows per step, adjusted to ftsBackfillStepMs
		first: number;
		end: number;
		started: number;
		lastLog: number;
	} | null = null;

	// Cleared channels with rows still to delete, kept in the options table
	// as well so that a restart carries on where this left off. Pending
	// until the search index is tidied up after them, too.
	private clears = new Map<string, HistoryClear>();
	private clearsPending = false;
	private clearTimer: NodeJS.Timeout | null = null;
	private clearRows = 1000; // rows per step, adjusted to clearStepMs
	private tidyPages = 100; // index pages per step, likewise
	private ftsMergeOff = false;

	constructor(userName: string) {
		this.userName = userName;
		this.isEnabled = false;
		this.initDone = new Deferred();
	}

	async _enable(connection_string: string) {
		try {
			this.database = new Database(connection_string);
			await this.run_pragmas(); // must be done outside of a transaction
			await this.run_migrations();

			// Prepare insert statement for batching
			this.insertStmt = this.database.prepare(
				"INSERT INTO messages(network, channel, time, type, msg) VALUES(?, ?, ?, ?, ?)"
			);
			this.ftsInsertStmt = this.database.prepare(
				"INSERT INTO messages_fts(rowid, text) VALUES(?, ?)"
			);
		} catch (e) {
			this.isEnabled = false;
			throw Helper.catch_to_error("Migration failed", e);
		}

		this.isEnabled = true;
		this.startSearchIndexBuild();
		this.loadHistoryClears();
	}

	private option(name: string): string | undefined {
		return this.database
			.prepare("SELECT value FROM options WHERE name = ?")
			.pluck()
			.get(name) as string | undefined;
	}

	/**
	 * Adds the messages stored before the search index existed to it, a step
	 * at a time between other work, so the server is usable meanwhile. Picks
	 * up where it left off after a restart. Search reads every message (as it
	 * always did) until the index is complete.
	 */
	private startSearchIndexBuild() {
		if (this.backfill) {
			return;
		}

		const next = this.option("fts_backfill_next");
		const end = this.option("fts_backfill_end");

		if (next === undefined || end === undefined) {
			this.searchIndexReady = true;
			return;
		}

		this.searchIndexReady = false;
		this.searchIndexError = null;
		this.backfill = {
			timer: null,
			rows: 2000,
			first: Number(next),
			end: Number(end),
			started: Date.now(),
			lastLog: Date.now(),
		};

		// A larger page cache keeps the index's pages in memory between steps
		// instead of re-reading them, which is most of the cost on slow disks.
		// 64 MiB, back to the default once the index is complete.
		this.database.pragma("cache_size = -65536");

		log.info(
			this.finishing
				? `Building the search index for ${this.userName}`
				: `Building the search index for ${this.userName} in the background, search is slower until it's done`
		);
		this.scheduleSearchIndexStep();
	}

	private scheduleSearchIndexStep() {
		if (!this.backfill) {
			return;
		}

		// A few ms in between, so that a busy server isn't starved; longer
		// while someone searches
		const wait = Math.max(5, this.searchingUntil - Date.now());

		this.backfill.timer = setTimeout(() => {
			try {
				if (Date.now() < this.searchingUntil) {
					this.scheduleSearchIndexStep();
				} else if (this.backfill && !this.buildSearchIndexStep()) {
					this.scheduleSearchIndexStep();
				}
			} catch (err) {
				log.error(
					`Building the search index for ${this.userName} failed, search stays slow:`,
					String(err)
				);
				this.searchIndexError = String(err);
				this.backfill = null;
			}
		}, wait);
	}

	/**
	 * Indexes the next batch of messages. Returns true once the index is
	 * complete.
	 */
	buildSearchIndexStep(): boolean {
		const b = this.backfill;

		if (!b) {
			return true;
		}

		const started = Date.now();
		const next = Number(this.option("fts_backfill_next"));
		const rows = this.database
			.prepare(
				"SELECT id, json_extract(msg, '$.text') AS text FROM messages WHERE id >= ? AND id <= ? AND type = 'message' AND json_type(msg, '$.text') = 'text' ORDER BY id LIMIT ?"
			)
			.all(next, b.end, b.rows) as {id: number; text: string}[];
		const finished = rows.length < b.rows;

		this.database.transaction(() => {
			for (const row of rows) {
				this.ftsInsertStmt!.run(row.id, row.text);
			}

			if (finished) {
				this.database.exec(
					"DELETE FROM options WHERE name IN ('fts_backfill_next', 'fts_backfill_end')"
				);
			} else {
				this.database
					.prepare("UPDATE options SET value = ? WHERE name = 'fts_backfill_next'")
					.run(String(rows[rows.length - 1].id + 1));
			}
		})();

		if (finished) {
			this.searchIndexReady = true;
			this.backfill = null;
			this.database.pragma("cache_size = -2000");
			log.info(
				`Search index for ${this.userName} is complete (took ${((Date.now() - b.started) / 1000).toFixed(0)}s)`
			);
			return true;
		}

		// Aim each step at ftsBackfillStepMs, unless nothing else is waiting
		if (!this.finishing) {
			const took = Math.max(1, Date.now() - started);
			b.rows = Math.min(
				50000,
				Math.max(200, Math.round((b.rows * ftsBackfillStepMs) / took))
			);
		}

		if (Date.now() - b.lastLog > 30000) {
			b.lastLog = Date.now();
			const at = rows[rows.length - 1].id;
			const percent = b.end > b.first ? ((at - b.first) / (b.end - b.first)) * 100 : 100;
			log.info(`Search index for ${this.userName}: ${percent.toFixed(0)}%`);
		}

		return false;
	}

	/**
	 * Finishes the search index build in one go, for the command line and
	 * tests. Resolves at once if the index is complete.
	 */
	async finishSearchIndex() {
		this.finishing = true;
		this.startSearchIndexBuild();

		if (this.backfill?.timer) {
			clearTimeout(this.backfill.timer);
		}

		if (this.backfill) {
			// No one is waiting on the server here, so take bigger steps
			this.backfill.rows = 50000;
		}

		try {
			while (!this.buildSearchIndexStep()) {
				// Let anything else that's queued run between steps
				await new Promise((resolve) => setImmediate(resolve));
			}
		} finally {
			this.finishing = false;
		}
	}

	// The storage thread passes the folder, as it doesn't load the config
	async enable(logsPath = Config.getUserLogsPath()) {
		const sqlitePath = path.join(logsPath, `${this.userName}.sqlite3`);

		try {
			await fs.mkdir(logsPath, {recursive: true});
		} catch (e) {
			throw Helper.catch_to_error("Unable to create logs directory", e);
		}

		try {
			await this._enable(sqlitePath);
		} finally {
			this.initDone.resolve(); // unblock the instance methods
		}
	}

	async setup_new_db() {
		for (const stmt of schema) {
			await this.serialize_run(stmt);
		}

		await this.serialize_run(
			"INSERT INTO options (name, value) VALUES ('schema_version', ?)",
			currentSchemaVersion.toString()
		);
	}

	async current_version(): Promise<number> {
		const have_options = await this.serialize_get(
			"select 1 from sqlite_master where type = 'table' and name = 'options'"
		);

		if (!have_options) {
			return 0;
		}

		const version = await this.serialize_get(
			"SELECT value FROM options WHERE name = 'schema_version'"
		);

		if (version === undefined) {
			// technically shouldn't happen, means something created a schema but didn't populate it
			// we'll try our best to recover
			return 0;
		}

		const storedSchemaVersion = parseInt(
			(version as Record<string, unknown>).value as string,
			10
		);
		return storedSchemaVersion;
	}

	async update_version_in_db() {
		return this.serialize_run(
			"UPDATE options SET value = ? WHERE name = 'schema_version'",
			currentSchemaVersion.toString()
		);
	}

	async _run_migrations(dbVersion: number) {
		log.info(
			`sqlite messages schema version for ${this.userName} is out of date (${dbVersion} < ${currentSchemaVersion}). Running migrations, this can take a while on a large history.`
		);

		const to_execute = necessaryMigrations(dbVersion);

		for (const stmt of to_execute.map((m) => m.stmts).flat()) {
			await this.serialize_run(stmt);
		}

		await this.update_version_in_db();
	}

	async run_pragmas() {
		await this.serialize_run("PRAGMA foreign_keys = ON;");

		// better-sqlite3 is synchronous, so every commit blocks the event loop
		// for as long as the fsyncs take. With the default rollback journal
		// that is two or more fsyncs per batch flush; WAL with NORMAL needs
		// none on commit and stays consistent across crashes (at worst the
		// last few commits are lost on power failure).
		this.database.pragma("journal_mode = WAL");
		this.database.pragma("synchronous = NORMAL");
	}

	async run_migrations() {
		const version = await this.current_version();

		if (version > currentSchemaVersion) {
			throw new Error(
				`sqlite messages schema version is higher than expected (${version} > ${currentSchemaVersion}). Is The Lounge out of date?`
			);
		} else if (version === currentSchemaVersion) {
			return; // nothing to do
		}

		const started = Date.now();
		await this.serialize_run("BEGIN EXCLUSIVE TRANSACTION");

		try {
			if (version === 0) {
				await this.setup_new_db();
			} else {
				await this._run_migrations(version);
			}

			await this.insert_rollback_since(version);
		} catch (err) {
			await this.serialize_run("ROLLBACK");
			throw err;
		}

		await this.serialize_run("COMMIT");

		// On an open store, start indexing what the migration left to index.
		// _enable() does it once it has prepared its statements.
		if (this.ftsInsertStmt) {
			this.startSearchIndexBuild();
		}

		// No VACUUM here: it rewrites the whole file, which on a large history
		// takes as long as the migration itself and needs that much free disk
		// space again, while none of the migrations free up space worth
		// reclaiming. `thelounge storage vacuum` does it on demand.
		if (version !== 0) {
			log.info(
				`sqlite migrations for ${this.userName} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`
			);
		}
	}

	// helper method that vacuums the db, meant to be used by migration related cli commands
	async vacuum() {
		await this.serialize_run("VACUUM");
		// The write-ahead log keeps the size it grew to; give that back too
		this.database.pragma("wal_checkpoint(TRUNCATE)");
	}

	async close() {
		if (!this.isEnabled) {
			return;
		}

		// Flush any pending batched messages
		await this.flushBatch();

		// Clear batch timer
		if (this.batchTimer) {
			clearTimeout(this.batchTimer);
			this.batchTimer = null;
		}

		// The search index build continues from here on the next start
		if (this.backfill?.timer) {
			clearTimeout(this.backfill.timer);
		}

		this.backfill = null;

		// So do cleared channels still being deleted
		if (this.clearTimer) {
			clearTimeout(this.clearTimer);
			this.clearTimer = null;
		}

		this.isEnabled = false;

		try {
			this.database.close();
		} catch (err: unknown) {
			throw new Error(
				`Failed to close sqlite database: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	/**
	 * Flush batched messages to database using a transaction
	 */
	private async flushBatch(): Promise<void> {
		if (this.batchQueue.length === 0) {
			return Promise.resolve();
		}

		if (!this.insertStmt || !this.ftsInsertStmt) {
			log.error("Cannot flush batch: insert statement not prepared");
			return Promise.resolve();
		}

		const messages = this.batchQueue.splice(0); // Take all messages and clear queue

		try {
			// Use transaction for batch insert (much faster than individual inserts)
			const transaction = this.database.transaction((msgs: StoredRow[]) => {
				for (const msg of msgs) {
					const inserted = this.insertStmt!.run(
						msg.network,
						msg.channel,
						msg.time,
						msg.type,
						msg.msg
					);

					// Same transaction, so the index can't get ahead of or
					// fall behind the messages table
					if (msg.searchText !== null) {
						this.ftsInsertStmt!.run(inserted.lastInsertRowid, msg.searchText);
					}
				}
			});

			transaction(messages);
		} catch (err) {
			log.error(
				`Failed to flush message batch: ${err instanceof Error ? err.message : String(err)}`
			);
			// Re-add messages to queue on failure
			this.batchQueue.unshift(...messages);
			throw err;
		}
	}

	/**
	 * Schedule a batch flush
	 */
	private scheduleBatchFlush(): void {
		if (this.batchTimer) {
			return; // Timer already scheduled
		}

		this.batchTimer = setTimeout(() => {
			this.batchTimer = null;
			this.flushBatch().catch((err) => log.error(`Batch flush error: ${err}`));
		}, this.batchTimeout);
	}

	async fetch_rollbacks(since_version: number) {
		const res = await this.serialize_fetchall(
			`select version, rollback_forbidden, statement
            from rollback_steps
            join migrations on migrations.id=rollback_steps.migration_id
            where version > ?
            order by version desc, step asc, rollback_steps.id asc`,
			since_version
		);
		const result: Rollback[] = [];

		// convert to Rollback[]
		// requires ordering in the sql statement
		for (const raw of res) {
			const last = result.at(-1);

			const r = raw as Record<string, unknown>;

			if (!last || r.version !== last.version) {
				result.push({
					version: r.version as number,
					rollback_forbidden: Boolean(r.rollback_forbidden),
					stmts: [r.statement as string],
				});
			} else {
				last.stmts.push(r.statement as string);
			}
		}

		return result;
	}

	async delete_migrations_older_than(version: number) {
		return this.serialize_run("delete from migrations where migrations.version > ?", version);
	}

	async _downgrade_to(version: number) {
		const _rollbacks = await this.fetch_rollbacks(version);

		if (_rollbacks.length === 0) {
			return version;
		}

		const forbidden = _rollbacks.find((item) => item.rollback_forbidden);

		if (forbidden) {
			throw Error(`can't downgrade past ${forbidden.version}`);
		}

		for (const rollback of _rollbacks) {
			for (const stmt of rollback.stmts) {
				await this.serialize_run(stmt);
			}
		}

		await this.delete_migrations_older_than(version);
		await this.update_version_in_db();

		return version;
	}

	async downgrade_to(version: number) {
		if (version <= 0) {
			throw Error(`${version} is not a valid version to downgrade to`);
		}

		await this.serialize_run("BEGIN EXCLUSIVE TRANSACTION");

		let new_version: number;

		try {
			new_version = await this._downgrade_to(version);
		} catch (err) {
			await this.serialize_run("ROLLBACK");
			throw err;
		}

		await this.serialize_run("COMMIT");
		return new_version;
	}

	async downgrade() {
		const res = await this.downgrade_to(currentSchemaVersion);
		return res;
	}

	async insert_rollback_since(version: number) {
		const missing = newRollbacks(version);

		for (const rollback of missing) {
			const migration = await this.serialize_get(
				`insert into migrations
                (version, rollback_forbidden)
                values (?, ?)
                returning id`,
				rollback.version,
				rollback.rollback_forbidden || 0
			);

			let step = 0;

			for (const stmt of rollback.stmts) {
				await this.serialize_run(
					`insert into rollback_steps
                    (migration_id, step, statement)
                    values (?, ?, ?)`,
					(migration as Record<string, unknown>).id,
					step,
					stmt
				);
				step++;
			}
		}
	}

	async index(network: Network, channel: Chan, msg: Msg) {
		return this.indexRow(toStoredRow(network.uuid, channel.name, msg));
	}

	/**
	 * Stores a message already turned into its row by toStoredRow(), which is
	 * how the storage thread gets them.
	 */
	async indexRow(row: StoredRow) {
		await this.initDone.promise;

		if (!this.isEnabled) {
			return;
		}

		// Add to batch queue instead of immediate insert
		this.batchQueue.push(row);

		// Flush batch if it reaches the size limit
		if (this.batchQueue.length >= this.batchSize) {
			await this.flushBatch();
		} else {
			// Schedule flush after timeout
			this.scheduleBatchFlush();
		}
	}

	async deleteChannel(network: Pick<Network, "uuid">, channel: Pick<Channel, "name">) {
		await this.initDone.promise;

		if (!this.isEnabled) {
			return;
		}

		// Queued rows are part of the history being cleared
		await this.flushBatch();

		const upto = this.database.prepare("SELECT max(id) FROM messages").pluck().get() as
			number | null;

		if (upto === null) {
			return;
		}

		const clear = {network: network.uuid, channel: channel.name.toLowerCase(), upto};

		// Recorded before anything is deleted: from here on reads leave these
		// rows out, also after a restart half way through
		this.clears.set(clearKey(clear.network, clear.channel), clear);
		this.saveHistoryClears();

		// Most channels are gone after this first step. The rest, and tidying
		// up the index, carries on in the background, or already does for an
		// earlier clear.
		if (!this.clearTimer) {
			this.runClearSteps();
		}
	}

	/**
	 * Does the next piece of clearing history: deletes a batch of rows of a
	 * cleared channel or, once none are left, merges a little of the search
	 * index. Returns true once there is nothing left to do.
	 */
	clearHistoryStep(): boolean {
		if (!this.clearsPending) {
			return true;
		}

		const next = this.clears.entries().next();

		if (next.done) {
			return this.tidySearchIndexStep();
		}

		const [key, clear] = next.value;

		// Each deleted row goes on a list in the index, which is rewritten
		// whenever it doubles, and pays for merging some of the index. That
		// merging made steps take seconds on a big history, most of all with
		// 'deletemerge' at its default, which rewrites whole parts of the
		// index once a tenth of their rows are deleted. It is off while
		// deleting; tidySearchIndexStep() does it afterwards, in small steps.
		if (!this.ftsMergeOff) {
			this.setFtsMerging(false);
		}

		const started = Date.now();
		const deleted = this.database
			.prepare(
				"DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE network = ? AND channel = ? AND id <= ? LIMIT ?)"
			)
			.run(clear.network, clear.channel, clear.upto, this.clearRows).changes;

		if (deleted < this.clearRows) {
			this.clears.delete(key);
			this.saveHistoryClears();
		}

		// Aim the next step at clearStepMs, growing at most twofold at a time
		const took = Math.max(1, Date.now() - started);
		this.clearRows = Math.min(
			this.clearRows * 2,
			50000,
			Math.max(100, Math.round((this.clearRows * clearStepMs) / took))
		);

		return false;
	}

	/**
	 * Merges a few pages of the search index, which drops the rows deleted
	 * from it. Left to the deletes that come later, it made each storage
	 * cleaner pass take seconds until all of it was done, as every deleted
	 * row pays for some merging. Returns true once nothing is left to merge.
	 */
	private tidySearchIndexStep(): boolean {
		if (this.ftsMergeOff) {
			this.setFtsMerging(true);
		}

		const totalChanges = this.database.prepare("SELECT total_changes()").pluck();
		const before = totalChanges.get() as number;
		const started = Date.now();
		this.database
			.prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES('merge', ?)")
			.run(BigInt(this.tidyPages));

		// Fewer than two changes is how SQLite tells there was nothing to merge
		if ((totalChanges.get() as number) - before >= 2) {
			const took = Math.max(1, Date.now() - started);
			this.tidyPages = Math.min(
				this.tidyPages * 2,
				5000,
				Math.max(16, Math.round((this.tidyPages * clearStepMs) / took))
			);
			return false;
		}

		this.clearsPending = false;
		this.database.prepare("DELETE FROM options WHERE name = 'history_clears'").run();
		return true;
	}

	/**
	 * Does everything clearing history has left in one go, for tests.
	 * Resolves at once if there is nothing.
	 */
	async finishClearingHistory() {
		if (this.clearTimer) {
			clearTimeout(this.clearTimer);
			this.clearTimer = null;
		}

		while (!this.clearHistoryStep()) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	}

	private runClearSteps() {
		this.clearTimer = null;

		try {
			if (!this.clearHistoryStep()) {
				// A few ms in between, so that a busy server isn't starved
				this.clearTimer = setTimeout(() => this.runClearSteps(), 5);
			}
		} catch (err) {
			// The rows stay hidden, the next start carries on
			log.error(`Clearing history for ${this.userName} failed:`, String(err));
		}
	}

	// Turns the index's own merging after writes and deletes off or back on
	private setFtsMerging(on: boolean) {
		const set = this.database.prepare(
			"INSERT INTO messages_fts(messages_fts, rank) VALUES(?, ?)"
		);

		// As BigInts, the index refuses numbers bound as floats
		set.run("automerge", BigInt(on ? ftsDefaultAutomerge : 0));
		set.run("deletemerge", BigInt(on ? ftsDefaultDeleteMerge : 0));
		this.ftsMergeOff = !on;
	}

	// The saved list stays, empty, until the index is tidied up as well
	private loadHistoryClears() {
		this.clears.clear();
		const saved = this.option("history_clears");

		if (saved === undefined) {
			return;
		}

		this.clearsPending = true;

		try {
			for (const clear of JSON.parse(saved) as HistoryClear[]) {
				this.clears.set(clearKey(clear.network, clear.channel), clear);
			}
		} catch (err) {
			log.error(
				`Unreadable list of cleared channels for ${this.userName}, their history may show again:`,
				String(err)
			);
		}

		this.clearTimer = setTimeout(() => this.runClearSteps(), 5);
	}

	private saveHistoryClears() {
		this.clearsPending = true;
		this.database
			.prepare("INSERT OR REPLACE INTO options (name, value) VALUES ('history_clears', ?)")
			.run(JSON.stringify(Array.from(this.clears.values())));
	}

	/**
	 * Leaves out the rows of a cleared channel that are still to be deleted,
	 * for a query of that channel's rows: what to read from, a condition on
	 * `id` and its parameters. Plain `messages` when nothing is waiting.
	 */
	private hideCleared(
		network: string,
		channel: string
	): {table: string; sql: string; params: number[]} {
		const clear = this.clears.get(clearKey(network, channel.toLowerCase()));

		if (!clear) {
			return {table: "messages", sql: "", params: []};
		}

		// What is left of the channel is what was stored since the clear, so
		// look rows up by id: through the channel's index the query would
		// step over every hidden row (85ms for 1.3M of them)
		return {table: "messages NOT INDEXED", sql: " AND id > ?", params: [clear.upto]};
	}

	async getMessages(
		network: Network,
		channel: Channel,
		ensureIdAbove: (maxId: number) => void
	): Promise<Message[]> {
		const messages = await this.getChannelHistory(
			network.uuid,
			channel.name,
			historyLimit(Config.values.maxHistory)
		);

		// Ensure client.idMsg is higher than any loaded message ID
		ensureIdAbove(maxMessageId(messages));

		return messages;
	}

	/**
	 * The newest `limit` messages of a channel, oldest first. What
	 * getMessages() reads, for callers that work out the limit themselves.
	 */
	async getChannelHistory(
		networkUuid: string,
		channelName: string,
		limit: number
	): Promise<Message[]> {
		await this.initDone.promise;

		if (!this.isEnabled || limit === 0) {
			return [];
		}

		// Flush any pending batched writes before reading
		await this.flushBatch();

		const hidden = this.hideCleared(networkUuid, channelName);

		// Select id from SQLite to use as the canonical message ID
		const rows = await this.serialize_fetchall(
			`SELECT id, msg, type, time FROM ${hidden.table} WHERE network = ? AND channel = ?${hidden.sql} ORDER BY time DESC, id DESC LIMIT ?`,
			networkUuid,
			channelName.toLowerCase(),
			...hidden.params,
			limit
		);

		return rows.reverse().map(rowToMessage);
	}

	/**
	 * A page of results the old way, all at once, oldest first: the newest
	 * page for offset 0, then older ones. Built from searchBatch(), which is
	 * what the server uses.
	 */
	async search(query: SearchQuery): Promise<SearchResponse> {
		const found: Message[] = [];
		let cursor: SearchCursor | null = null;

		do {
			const batch = await this.searchBatch({
				searchTerm: query.searchTerm,
				networkUuid: query.networkUuid,
				channelName: query.channelName,
				cursor,
				rows: 1000,
			});
			found.push(...batch.results);
			cursor = batch.cursor;
		} while (cursor && found.length < query.offset + searchPageSize);

		const page = sortNewestFirst(found).slice(query.offset, query.offset + searchPageSize);

		return {...query, results: page.reverse()};
	}

	/**
	 * One step of a search, newest first: looks at up to `rows` index hits
	 * (or messages, when the index can't help) below the cursor, and returns
	 * the ones that match with the cursor to go on from. Results come in id
	 * order, not quite time order: see SearchResultsChunk.
	 *
	 * Kept short on purpose, so the storage thread can do other work in
	 * between and a search can stop as soon as it has a page.
	 */
	async searchBatch(query: SearchBatchQuery): Promise<{
		results: Message[];
		cursor: SearchCursor | null;
		stats: SearchBatchStats;
	}> {
		await this.initDone.promise;

		if (!this.isEnabled) {
			// this should never be hit as messageProvider is checked in client.search()
			throw new Error(
				"search called but sqlite provider not enabled. This is a programming error"
			);
		}

		// Flush any pending batched writes before searching
		const flushStart = performance.now();

		if (!query.cursor) {
			await this.flushBatch();
		}

		const flushMs = performance.now() - flushStart;
		const filter = this.searchFilter(query);
		// The next batch of this search comes soon; the index build can wait
		this.searchingUntil = Date.now() + 250;
		const rows = Math.max(1, Math.floor(query.rows));
		const columns = "m.id, m.msg, m.type, m.time, m.network, m.channel";
		const fetch = (ids: number[]) =>
			this.database
				.prepare(
					`SELECT ${columns} FROM json_each(?) c CROSS JOIN messages m ON m.id = c.value WHERE ${filter.where}`
				)
				.all(JSON.stringify(ids), ...filter.params);

		// A search keeps the way it started: the index may complete meanwhile,
		// and a lookup cursor means nothing to a scan
		const plan =
			query.cursor === null
				? this.searchPlan(filter.term)
				: query.cursor.kind === "lookup"
					? {match: trigramQuery(filter.term)}
					: {match: null, reason: this.searchPlan(filter.term).reason};

		if (plan.match !== null) {
			const beforeId = query.cursor?.kind === "lookup" ? query.cursor.beforeId : newestCursor;
			const indexStart = performance.now();
			const ids = this.database
				.prepare(
					"SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid < ? ORDER BY rowid DESC LIMIT ?"
				)
				.pluck()
				.all(plan.match, beforeId, rows) as number[];
			const indexMs = performance.now() - indexStart;
			const queryStart = performance.now();
			const found = ids.length ? fetch(ids) : [];

			return {
				results: found.map(rowToMessage),
				cursor: ids.length < rows ? null : {kind: "lookup", beforeId: ids[ids.length - 1]},
				stats: {
					strategy: "lookup",
					examined: ids.length,
					flushMs,
					indexMs,
					queryMs: performance.now() - queryStart,
				},
			};
		}

		// Walk the messages in scope newest first, on an index that has them
		// in that order. Named explicitly because the planner otherwise
		// prefers msg_type_idx and sorts every message there is.
		const before =
			query.cursor?.kind === "scan"
				? [query.cursor.beforeTime, query.cursor.beforeId]
				: [newestCursor, newestCursor];
		const scope = query.networkUuid && query.channelName;
		const walk = scope
			? "messages m INDEXED BY network_channel_time WHERE m.network = ? AND m.channel = ? AND"
			: "messages m INDEXED BY time WHERE";
		const scopeParams = scope ? [query.networkUuid, query.channelName.toLowerCase()] : [];
		const queryStart = performance.now();

		// The oldest row this batch looks at, from the index alone; none when
		// fewer than `rows` are left
		const edge = this.database
			.prepare(
				`SELECT m.time, m.id FROM ${walk} (m.time, m.id) < (?, ?) ORDER BY m.time DESC, m.id DESC LIMIT 1 OFFSET ?`
			)
			.get(...scopeParams, ...before, rows - 1) as {time: number; id: number} | undefined;

		// The matches between the cursor and the edge, in one pass
		const found = this.database
			.prepare(
				`SELECT ${columns} FROM ${walk} (m.time, m.id) < (?, ?)${edge ? " AND (m.time, m.id) >= (?, ?)" : ""} AND ${filter.where} ORDER BY m.time DESC, m.id DESC`
			)
			.all(
				...scopeParams,
				...before,
				...(edge ? [edge.time, edge.id] : []),
				...filter.params
			);

		// Nothing older can match a dateafter: filter
		const exhausted = !edge || (filter.after !== null && edge.time < filter.after);
		const examined = edge
			? rows
			: (this.database
					.prepare(`SELECT count(*) FROM ${walk} (m.time, m.id) < (?, ?)`)
					.pluck()
					.get(...scopeParams, ...before) as number);
		const last = edge;

		return {
			results: found.map(rowToMessage),
			cursor:
				exhausted || !last
					? null
					: {kind: "scan", beforeTime: last.time, beforeId: last.id},
			stats: {
				strategy: "scan",
				reason: plan.reason,
				examined,
				flushMs,
				indexMs: 0,
				queryMs: performance.now() - queryStart,
			},
		};
	}

	/**
	 * The term without its filters (from:, datebefore:, dateafter:), and the
	 * condition every result has to meet, the text match included. All ways
	 * of searching check this against the stored row, so they find exactly
	 * the same messages.
	 */
	private searchFilter(
		query: Pick<SearchBatchQuery, "searchTerm" | "networkUuid" | "channelName">
	) {
		const searchTermParts = query.searchTerm.split(" ");

		let userFilter: string | null = null;
		let dateEndFilter: number | null = null;
		let dateStartFilter: number | null = null;

		for (const part of [...searchTermParts]) {
			if (part.startsWith("from:") && userFilter === null) {
				userFilter = part.slice(5);
				searchTermParts.splice(searchTermParts.indexOf(part), 1);
			}

			if (part.startsWith("datebefore:") && dateEndFilter === null) {
				const date = new Date(part.slice(11));

				if (!Number.isNaN(date.getTime())) {
					dateEndFilter = date.getTime();
					searchTermParts.splice(searchTermParts.indexOf(part), 1);
				}
			}

			if (part.startsWith("dateafter:") && dateStartFilter === null) {
				const date = new Date(part.slice(10));

				if (!Number.isNaN(date.getTime())) {
					dateStartFilter = date.getTime();
					searchTermParts.splice(searchTermParts.indexOf(part), 1);
				}
			}
		}

		const term = searchTermParts.join(" ");

		// Using the '@' character to escape '%' and '_' in patterns.
		const pattern = `%${term.replace(/([%_@])/g, "@$1")}%`;

		let where = "m.type = 'message' AND json_extract(m.msg, '$.text') LIKE ? ESCAPE '@'";
		const params: unknown[] = [pattern];

		if (query.networkUuid) {
			where += " AND m.network = ?";
			params.push(query.networkUuid);
		}

		if (query.channelName) {
			where += " AND m.channel = ?";
			params.push(query.channelName.toLowerCase());
		}

		if (userFilter !== null) {
			where += " AND LOWER(json_extract(m.msg, '$.from.nick')) = ?";
			params.push(userFilter.toLowerCase());
		}

		if (dateEndFilter !== null) {
			where += " AND m.time <= ?";
			params.push(dateEndFilter);
		}

		if (dateStartFilter !== null) {
			where += " AND m.time >= ?";
			params.push(dateStartFilter);
		}

		// Cleared channels whose rows aren't all deleted yet
		for (const clear of this.clears.values()) {
			if (
				(!query.networkUuid || query.networkUuid === clear.network) &&
				(!query.channelName || query.channelName.toLowerCase() === clear.channel)
			) {
				where += " AND NOT (m.network = ? AND m.channel = ? AND m.id <= ?)";
				params.push(clear.network, clear.channel, clear.upto);
			}
		}

		return {term, where, params, after: dateStartFilter};
	}

	/**
	 * Whether the search index can say where `term` is: the index query for
	 * it, or null and why not. Until every message is in the index, it can't
	 * say where a term isn't, so search reads the messages themselves.
	 */
	private searchPlan(term: string): {match: string | null; reason?: SearchScanReason} {
		if (!this.searchIndexReady) {
			return {
				match: null,
				reason: this.searchIndexError === null ? "index-building" : "index-failed",
			};
		}

		const match = trigramQuery(term);
		return match === null ? {match, reason: "short-term"} : {match};
	}

	/**
	 * Where the background search index build is.
	 */
	searchIndexState(): SearchIndexState {
		if (this.searchIndexReady) {
			return {state: "complete"};
		}

		const next = Number(this.option("fts_backfill_next"));
		const end = Number(this.option("fts_backfill_end"));
		// The build goes through ids from 0 up, across restarts
		const progress = end > 0 ? Math.min(1, Math.max(0, next / end)) : 0;
		// Ids, so an upper bound: deleted messages and non-messages are counted too
		const remaining = Math.max(0, end - next + 1);

		if (this.searchIndexError !== null || !this.backfill) {
			return {
				state: "failed",
				progress,
				remaining,
				error: this.searchIndexError ?? "The build isn't running",
			};
		}

		return {state: "building", progress, remaining, startedAt: this.backfill.started};
	}

	/**
	 * Size and settings of the database, all cheap to read: nothing here
	 * counts rows.
	 */
	async databaseStats(): Promise<DatabaseStats> {
		await this.initDone.promise;

		const file = this.database.name;

		const size = async (name: string) => {
			try {
				return (await fs.stat(name)).size;
			} catch {
				return 0;
			}
		};

		return {
			sqliteVersion: this.database.prepare("SELECT sqlite_version()").pluck().get() as string,
			schemaVersion: await this.current_version(),
			fileBytes: await size(file),
			walBytes: await size(`${file}-wal`),
			pageSize: this.database.pragma("page_size", {simple: true}) as number,
			pages: this.database.pragma("page_count", {simple: true}) as number,
			freePages: this.database.pragma("freelist_count", {simple: true}) as number,
			journalMode: this.database.pragma("journal_mode", {simple: true}) as string,
			cacheKiB: cacheKiB(
				this.database.pragma("cache_size", {simple: true}) as number,
				this.database.pragma("page_size", {simple: true}) as number
			),
			maxRowId:
				(this.database.prepare("SELECT max(id) FROM messages").pluck().get() as
					number | null) ?? 0,
			pendingClears: this.clears.size,
		};
	}

	/**
	 * Times reads of random blocks of the database file, to tell a slow disk
	 * apart from slow queries. Blocks already in the OS cache read fast, so a
	 * large database shows the disk best.
	 */
	async probeDisk(reads = 64, blockBytes = 4096): Promise<DiskProbe> {
		await this.initDone.promise;

		const handle = await fs.open(this.database.name, "r");
		const times: number[] = [];

		try {
			const {size} = await handle.stat();
			const blocks = Math.max(1, Math.floor(size / blockBytes));
			const buffer = Buffer.alloc(blockBytes);

			for (let i = 0; i < reads; i++) {
				const position = Math.floor(Math.random() * blocks) * blockBytes;
				const start = performance.now();
				await handle.read(buffer, 0, blockBytes, position);
				times.push(performance.now() - start);
			}
		} finally {
			await handle.close();
		}

		times.sort((a, b) => a - b);
		const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))];

		return {
			reads,
			blockBytes,
			medianMs: at(0.5),
			p90Ms: at(0.9),
			maxMs: times[times.length - 1],
		};
	}

	async deleteMessages(req: DeletionRequest): Promise<number> {
		await this.initDone.promise;

		// Flush any pending batched writes before deleting
		await this.flushBatch();

		let sql = "delete from messages where id in (select id from messages where\n";

		// We roughly get a timestamp from N days before.
		// We don't adjust for daylight savings time or other weird time jumps
		const millisecondsInDay = 24 * 60 * 60 * 1000;
		const deleteBefore = Date.now() - req.olderThanDays * millisecondsInDay;
		sql += "time <= ?\n";
		const params: (string | number)[] = [deleteBefore];

		if (req.messageTypes !== null) {
			const placeholder = new Array(req.messageTypes.length).fill("?").join(",");
			sql += `and type in (${placeholder})\n`;
			params.push(...req.messageTypes);
		}

		sql += "order by time asc\n";
		sql += "limit ?\n";
		params.push(req.limit);
		sql += ")";

		return this.serialize_run(sql, ...params);
	}

	/**
	 * Highest message id this database knows about, looking at both the row id
	 * and the id stored in the message JSON. Ids are handed out by an in-memory
	 * counter that restarts with the server, so the counter has to be moved past
	 * this before any new message is created, otherwise new ids collide with
	 * stored ones once history is loaded lazily.
	 */
	async getMaxMessageId(): Promise<number> {
		await this.initDone.promise;

		if (!this.isEnabled) {
			return 0;
		}

		await this.flushBatch();

		// Ids only grow over time, so the newest rows carry the highest ones
		const rows = await this.serialize_fetchall(
			"SELECT id, json_extract(msg, '$.id') AS msgId FROM messages ORDER BY id DESC LIMIT 100"
		);

		let maxId = 0;

		for (const row of rows) {
			const r = row as Record<string, unknown>;
			maxId = Math.max(maxId, r.id as number, typeof r.msgId === "number" ? r.msgId : 0);
		}

		return maxId;
	}

	/**
	 * Get messages at or before a specific timestamp, oldest first.
	 *
	 * With `inclusive` the rows sharing the anchor's exact millisecond are
	 * returned as well; callers drop the ones they already hold by id. Paging
	 * with a strict "<" would silently skip same-millisecond siblings of the
	 * anchor forever.
	 */
	async getMessagesBefore(
		networkUuid: string,
		channelName: string,
		beforeTime: number,
		limit: number,
		inclusive = false
	): Promise<Message[]> {
		await this.initDone.promise;

		if (!this.isEnabled) {
			return [];
		}

		// Flush any pending batched writes before reading
		await this.flushBatch();

		const hidden = this.hideCleared(networkUuid, channelName);
		const rows = await this.serialize_fetchall(
			`SELECT id, msg, type, time FROM ${hidden.table} WHERE network = ? AND channel = ? AND time ${
				inclusive ? "<=" : "<"
			} ?${hidden.sql} ORDER BY time DESC, id DESC LIMIT ?`,
			networkUuid,
			channelName.toLowerCase(),
			beforeTime,
			...hidden.params,
			limit
		);

		return rows.reverse().map(rowToMessage);
	}

	/**
	 * Get the messages around a specific timestamp, oldest first, for jumping
	 * to a point in history that isn't loaded. Also reports whether storage
	 * holds anything beyond either end of what is returned.
	 */
	async getMessagesAround(
		networkUuid: string,
		channelName: string,
		targetTime: number,
		limit: number = 200
	): Promise<{messages: Message[]; hasMoreBefore: boolean; hasMoreAfter: boolean}> {
		await this.initDone.promise;

		if (!this.isEnabled) {
			return {messages: [], hasMoreBefore: false, hasMoreAfter: false};
		}

		// Flush any pending batched writes before reading
		await this.flushBatch();

		const halfLimit = Math.floor(limit / 2);
		const hidden = this.hideCleared(networkUuid, channelName);

		// One row more than needed on each side tells whether there is more
		const beforeRows = await this.serialize_fetchall(
			`SELECT id, msg, type, time FROM ${hidden.table} WHERE network = ? AND channel = ? AND time <= ?${hidden.sql} ORDER BY time DESC, id DESC LIMIT ?`,
			networkUuid,
			channelName.toLowerCase(),
			targetTime,
			...hidden.params,
			halfLimit + 1
		);

		const afterRows = await this.serialize_fetchall(
			`SELECT id, msg, type, time FROM ${hidden.table} WHERE network = ? AND channel = ? AND time > ?${hidden.sql} ORDER BY time ASC, id ASC LIMIT ?`,
			networkUuid,
			channelName.toLowerCase(),
			targetTime,
			...hidden.params,
			halfLimit + 1
		);

		const hasMoreBefore = beforeRows.length > halfLimit;
		const hasMoreAfter = afterRows.length > halfLimit;

		const allRows = [
			...beforeRows.slice(0, halfLimit).reverse(),
			...afterRows.slice(0, halfLimit),
		];

		return {messages: allRows.map(rowToMessage), hasMoreBefore, hasMoreAfter};
	}

	/**
	 * Get messages at or after a specific timestamp, oldest first.
	 *
	 * Rows sharing the anchor's exact millisecond are returned as well, callers
	 * drop the ones they already hold. See getMessagesBefore() for why.
	 */
	async getMessagesAfter(
		networkUuid: string,
		channelName: string,
		afterTime: number,
		limit: number
	): Promise<Message[]> {
		await this.initDone.promise;

		if (!this.isEnabled) {
			return [];
		}

		// Flush any pending batched writes before reading
		await this.flushBatch();

		const hidden = this.hideCleared(networkUuid, channelName);
		const rows = await this.serialize_fetchall(
			`SELECT id, msg, type, time FROM ${hidden.table} WHERE network = ? AND channel = ? AND time >= ?${hidden.sql} ORDER BY time ASC, id ASC LIMIT ?`,
			networkUuid,
			channelName.toLowerCase(),
			afterTime,
			...hidden.params,
			limit
		);

		return rows.map(rowToMessage);
	}

	canProvideMessages() {
		return this.isEnabled;
	}

	private serialize_run(stmt: string, ...params: unknown[]): Promise<number> {
		try {
			const result = this.database.prepare(stmt).run(...params);
			return Promise.resolve(result.changes);
		} catch (err) {
			return Promise.reject(err instanceof Error ? err : new Error(String(err)));
		}
	}

	private serialize_fetchall(stmt: string, ...params: unknown[]): Promise<unknown[]> {
		try {
			const rows = this.database.prepare(stmt).all(...params);
			return Promise.resolve(rows);
		} catch (err) {
			return Promise.reject(err instanceof Error ? err : new Error(String(err)));
		}
	}

	private serialize_get(stmt: string, ...params: unknown[]): Promise<unknown> {
		try {
			const row = this.database.prepare(stmt).get(...params);
			return Promise.resolve(row);
		} catch (err) {
			return Promise.reject(err instanceof Error ? err : new Error(String(err)));
		}
	}
}

// Newest first by time, then by id; the order search pages are cut in
export function sortNewestFirst<T extends {time: Date | number | string; id?: number}>(
	messages: T[]
): T[] {
	const time = (m: T) => new Date(m.time).getTime();
	return [...messages].sort((a, b) => time(b) - time(a) || (b.id ?? 0) - (a.id ?? 0));
}

// PRAGMA cache_size is in pages when positive, in KiB when negative
export function cacheKiB(cacheSize: number, pageSize: number): number {
	return cacheSize < 0 ? -cacheSize : Math.round((cacheSize * pageSize) / 1024);
}

/**
 * FTS5 query matching every row whose text contains all trigrams of `term`.
 *
 * With detail=none the index can't do phrase queries, which is what handing
 * it the raw term would be, so the term is cut into trigrams here and each
 * one is passed as its own quoted token. Returns null for terms too short to
 * have a trigram.
 */
export function trigramQuery(term: string): string | null {
	// By code point, the same way the tokenizer counts characters
	const chars = Array.from(term);

	// NUL can't be part of a query string, let the plain scan deal with it
	if (chars.length < 3 || term.includes("\0")) {
		return null;
	}

	const trigrams = new Set<string>();

	for (let i = 0; i + 3 <= chars.length; i++) {
		trigrams.add(
			`"${chars
				.slice(i, i + 3)
				.join("")
				.replace(/"/g, '""')}"`
		);
	}

	return Array.from(trigrams).join(" AND ");
}

// Turns a `SELECT id, msg, type, time` row back into a message. Search rows
// also select `network` and `channel`, which are kept on the message.
function rowToMessage(row: unknown): Message {
	const r = row as Record<string, unknown>;
	const msg = JSON.parse(r.msg as string);
	msg.time = r.time;
	msg.type = r.type;

	if (r.network !== undefined) {
		msg.networkUuid = r.network;
	}

	if (r.channel !== undefined) {
		msg.channelName = r.channel;
	}

	// Use stored ID from JSON if available, fall back to SQLite row ID
	if (typeof msg.id !== "number") {
		msg.id = r.id as number;
	}

	return new Msg(msg);
}

/**
 * How many messages of a channel's history are loaded for the `maxHistory`
 * setting: none for 0, 100k when it's unlimited (negative).
 */
export function historyLimit(maxHistory: number): number {
	return maxHistory < 0 ? 100000 : maxHistory;
}

export function maxMessageId(messages: Message[]): number {
	let maxId = 0;

	for (const msg of messages) {
		if (msg.id > maxId) {
			maxId = msg.id;
		}
	}

	return maxId;
}

export function necessaryMigrations(since: number): Migration[] {
	return migrations.filter((m) => m.version > since);
}

export function newRollbacks(since: number): Rollback[] {
	return rollbacks.filter((r) => r.version > since);
}

export default SqliteMessageStorage;
