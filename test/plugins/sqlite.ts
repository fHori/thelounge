import fs from "fs";
import os from "os";
import path from "path";
import {expect} from "chai";
import util from "../util.js";
import Msg from "../../server/models/msg.js";
import {MessageType} from "../../shared/types/msg.js";
import Config from "../../server/config.js";
import MessageStorage, {
	currentSchemaVersion,
	migrations,
	necessaryMigrations,
	rollbacks,
	searchLimits,
	trigramQuery,
} from "../../server/plugins/messageStorage/sqlite.js";
import Database from "better-sqlite3";
import type {DeletionRequest} from "../../server/plugins/messageStorage/types.js";
import type Network from "../../server/models/network.js";
import type {Channel} from "../../server/models/chan.js";

// Test-specific types for SQLite message storage tests
type SqlValue = string | number | boolean | null | Buffer;
// Storage only reads a network's uuid and a channel's name
const testNet = (uuid: string) => ({uuid}) as Network;
const testChan = (name: string) => ({name}) as Channel;

const orig_schema = [
	// Schema version #1
	// DO NOT CHANGE THIS IN ANY WAY, it's needed to properly test migrations
	"CREATE TABLE IF NOT EXISTS options (name TEXT, value TEXT, CONSTRAINT name_unique UNIQUE (name))",
	"CREATE TABLE IF NOT EXISTS messages (network TEXT, channel TEXT, time INTEGER, type TEXT, msg TEXT)",
	"CREATE INDEX IF NOT EXISTS network_channel ON messages (network, channel)",
	"CREATE INDEX IF NOT EXISTS time ON messages (time)",
];

const v1_schema_version = 1520239200;

const v1_dummy_messages = [
	{
		network: "8f650427-79a2-4950-b8af-94088b61b37c",
		channel: "##linux",
		time: 1594845354280,
		type: "message",
		msg: '{"from":{"mode":"","nick":"rascul"},"text":"db on a flash drive doesn\'t sound very nice though","self":false,"highlight":false,"users":[]}',
	},
	{
		network: "8f650427-79a2-4950-b8af-94088b61b37c",
		channel: "##linux",
		time: 1594845357234,
		type: "message",
		msg: '{"from":{"mode":"","nick":"GrandPa-G"},"text":"that\'s the point of changing to make sure.","self":false,"highlight":false,"users":[]}',
	},
	{
		network: "8f650427-79a2-4950-b8af-94088b61b37c",
		channel: "#pleroma-dev",
		time: 1594845358464,
		type: "message",
		msg: '{"from":{"mode":"@","nick":"rinpatch"},"text":"it\'s complicated","self":false,"highlight":false,"users":[]}',
	},
];

describe("SQLite migrations", function () {
	let db: Database.Database;

	function serialize_run(stmt: string, ...params: SqlValue[]): Promise<void> {
		try {
			db.prepare(stmt).run(...params);
			return Promise.resolve();
		} catch (err) {
			return Promise.reject(err instanceof Error ? err : new Error(String(err)));
		}
	}

	before(async function () {
		db = new Database(":memory:");

		for (const stmt of orig_schema) {
			await serialize_run(stmt);
		}

		for (const msg of v1_dummy_messages) {
			await serialize_run(
				"INSERT INTO messages(network, channel, time, type, msg) VALUES(?, ?, ?, ?, ?)",
				msg.network,
				msg.channel,
				msg.time,
				msg.type,
				msg.msg
			);
		}
	});

	after(function () {
		db.close();
	});

	it("has a down migration for every migration", function () {
		expect(migrations.length).to.eq(rollbacks.length);
		expect(migrations.map((m) => m.version)).to.have.ordered.members(
			rollbacks.map((r) => r.version)
		);
	});

	it("has working up-migrations", async function () {
		const to_execute = necessaryMigrations(v1_schema_version);
		expect(to_execute.length).to.eq(migrations.length);
		await serialize_run("BEGIN EXCLUSIVE TRANSACTION");

		for (const stmt of to_execute.map((m) => m.stmts).flat()) {
			await serialize_run(stmt);
		}

		await serialize_run("COMMIT TRANSACTION");
	});

	it("has working down-migrations", async function () {
		await serialize_run("BEGIN EXCLUSIVE TRANSACTION");

		for (const rollback of rollbacks.slice().reverse()) {
			if (rollback.rollback_forbidden) {
				throw Error(
					"Try to write a down migration, if you really can't, flip this to a break"
				);
			}

			for (const stmt of rollback.stmts) {
				await serialize_run(stmt);
			}
		}

		await serialize_run("COMMIT TRANSACTION");
	});
});

describe("SQLite unit tests", function () {
	let store: MessageStorage;

	beforeEach(async function () {
		store = new MessageStorage("testUser");
		await store._enable(":memory:");
		store.initDone.resolve();
	});

	afterEach(async function () {
		await store.close();
	});

	it("deletes messages when asked to", async function () {
		const baseDate = new Date();

		const net = testNet("testnet");
		const chan = testChan("#channel");

		for (let i = 0; i < 14; ++i) {
			await store.index(
				net,
				chan,
				new Msg({
					time: dateAddDays(baseDate, -i),
					text: `msg ${i}`,
				})
			);
		}

		const limit = 1;
		const delReq: DeletionRequest = {
			messageTypes: [MessageType.MESSAGE],
			limit: limit,
			olderThanDays: 2,
		};

		let deleted = await store.deleteMessages(delReq);
		expect(deleted).to.equal(limit, "number of deleted messages doesn't match");

		let id = 0;
		let messages = await store.getMessages(net, chan, () => id++);
		expect(messages.find((m) => m.text === "msg 13")).to.equal(undefined); // oldest gets deleted first

		// let's test if it properly cleans now
		delReq.limit = 100;
		deleted = await store.deleteMessages(delReq);
		expect(deleted).to.equal(11, "number of deleted messages doesn't match");
		messages = await store.getMessages(net, chan, () => id++);
		expect(messages.map((m) => m.text)).to.have.ordered.members(["msg 1", "msg 0"]);
	});

	it("deletes only the types it should", async function () {
		const baseDate = new Date();

		const net = testNet("testnet");
		const chan = testChan("#channel");

		for (let i = 0; i < 6; ++i) {
			await store.index(
				net,
				chan,
				new Msg({
					time: dateAddDays(baseDate, -i),
					text: `msg ${i}`,
					type: [
						MessageType.ACTION,
						MessageType.AWAY,
						MessageType.JOIN,
						MessageType.PART,
						MessageType.KICK,
						MessageType.MESSAGE,
					][i],
				})
			);
		}

		const delReq: DeletionRequest = {
			messageTypes: [MessageType.ACTION, MessageType.JOIN, MessageType.KICK],
			limit: 100, // effectively no limit
			olderThanDays: 0,
		};

		let deleted = await store.deleteMessages(delReq);
		expect(deleted).to.equal(3, "number of deleted messages doesn't match");

		let id = 0;
		let messages = await store.getMessages(net, chan, () => id++);
		expect(messages.map((m) => m.type)).to.have.ordered.members([
			MessageType.MESSAGE,
			MessageType.PART,
			MessageType.AWAY,
		]);

		delReq.messageTypes = [
			MessageType.JOIN, // this is not in the remaining set, just here as a dummy
			MessageType.PART,
			MessageType.MESSAGE,
		];
		deleted = await store.deleteMessages(delReq);
		expect(deleted).to.equal(2, "number of deleted messages doesn't match");
		messages = await store.getMessages(net, chan, () => id++);
		expect(messages.map((m) => m.type)).to.have.ordered.members([MessageType.AWAY]);
	});
});

// Fresh databases as other builds create them, to check that this one takes
// them over. DO NOT CHANGE: they have to match what those builds wrote.
const baseTables = [
	"CREATE TABLE options (name TEXT, value TEXT, CONSTRAINT name_unique UNIQUE (name))",
	"CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, network TEXT, channel TEXT, time INTEGER, type TEXT, msg TEXT)",
	"CREATE TABLE migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL UNIQUE, rollback_forbidden INTEGER DEFAULT 0 NOT NULL)",
	"CREATE TABLE rollback_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, migration_id INTEGER NOT NULL REFERENCES migrations ON DELETE CASCADE, step INTEGER NOT NULL, statement TEXT NOT NULL)",
];

const otherBuilds = [
	{
		name: "stock The Lounge 4.4 / tetrahydroc",
		version: 1703322560448,
		indexes: [
			"CREATE INDEX network_channel ON messages (network, channel)",
			"CREATE INDEX time ON messages (time)",
			"CREATE INDEX msg_type_idx on messages (type)",
		],
	},
	{
		name: "stock The Lounge 4.5",
		version: 1780272000000,
		indexes: [
			"CREATE INDEX time ON messages (time)",
			"CREATE INDEX msg_type_idx on messages (type)",
			"CREATE INDEX network_channel_time ON messages (network, channel, time)",
		],
	},
];

describe("SQLite databases from other builds", function () {
	let dir: string;

	beforeEach(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "thelounge-sqlite-"));
	});

	afterEach(function () {
		fs.rmSync(dir, {recursive: true, force: true});
	});

	for (const build of otherBuilds) {
		it(`should take over a database from ${build.name}`, async function () {
			const file = path.join(dir, "user.sqlite3");
			const db = new Database(file);

			for (const stmt of [...baseTables, ...build.indexes]) {
				db.exec(stmt);
			}

			db.prepare("INSERT INTO options (name, value) VALUES ('schema_version', ?)").run(
				build.version.toString()
			);

			for (const m of migrations.filter((x) => x.version <= build.version)) {
				db.prepare("INSERT INTO migrations (version) VALUES (?)").run(m.version);
			}

			const insert = db.prepare(
				"INSERT INTO messages (network, channel, time, type, msg) VALUES ('net', '#chan', ?, 'message', ?)"
			);

			for (let i = 0; i < 20; i++) {
				insert.run(1700000000000 + i, JSON.stringify({text: `old message ${i}`}));
			}

			db.close();

			const store = new MessageStorage("otherBuild");

			try {
				await store._enable(file);
				store.initDone.resolve();

				expect(await store.current_version()).to.equal(currentSchemaVersion);
				expect(
					store.database
						.prepare(
							"SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
						)
						.pluck()
						.all()
				).to.deep.equal(["msg_type_idx", "network_channel_time", "time"]);

				// The existing history is searchable through the new index
				const found = await store.search({
					searchTerm: "message 13",
					networkUuid: "net",
					channelName: "#chan",
					offset: 0,
				});
				expect(found.results.map((m) => m.text)).to.deep.equal(["old message 13"]);
			} finally {
				await store.close();
			}
		});
	}
});

describe("SQLite background search index", function () {
	this.timeout(20000);
	let dir: string;
	let file: string;
	const stores: MessageStorage[] = [];
	const total = 3000;

	// A history from before the search index, as this fork stored it
	beforeEach(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "thelounge-fts-"));
		file = path.join(dir, "user.sqlite3");
		const db = new Database(file);

		for (const stmt of [...baseTables, ...otherBuilds[1].indexes]) {
			db.exec(stmt);
		}

		db.prepare(
			"INSERT INTO options (name, value) VALUES ('schema_version', '1794816000000')"
		).run();

		const insert = db.prepare(
			"INSERT INTO messages (network, channel, time, type, msg) VALUES ('net', ?, ?, ?, ?)"
		);

		db.transaction(() => {
			for (let i = 0; i < total; i++) {
				// Every tenth row is a join, which isn't searchable
				const isJoin = i % 10 === 9;
				insert.run(
					i < total / 2 ? "#first" : "#second",
					1700000000000 + i,
					isJoin ? "join" : "message",
					JSON.stringify(isJoin ? {} : {text: `stored line ${i}`})
				);
			}
		})();
		db.close();
	});

	afterEach(async function () {
		for (const store of stores.splice(0)) {
			await store.close();
		}

		fs.rmSync(dir, {recursive: true, force: true});
	});

	const open = async () => {
		const store = new MessageStorage("backfill");
		stores.push(store);
		await store._enable(file);
		store.initDone.resolve();
		return store;
	};

	// Rows the index has for a term, straight from the index
	const indexed = (store: MessageStorage, term: string) =>
		store.database
			.prepare("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?")
			.pluck()
			.get(trigramQuery(term)) as number;

	const search = async (store: MessageStorage, term: string, channelName = "") =>
		(
			await store.search({searchTerm: term, networkUuid: "net", channelName, offset: 0})
		).results.map((m) => m.text);

	const searchable = Math.round(total * 0.9);

	it("should open at once and build the index in the background", async function () {
		const store = await open();

		expect(store.searchIndexReady).to.equal(false);
		expect(await search(store, "line 1234")).to.deep.equal(["stored line 1234"]);

		// Left to its timers, it finishes on its own
		for (let i = 0; i < 400 && !store.searchIndexReady; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}

		expect(store.searchIndexReady).to.equal(true);
		expect(indexed(store, "stored line")).to.equal(searchable);
		expect(await search(store, "line 1234")).to.deep.equal(["stored line 1234"]);
		expect(
			store.database
				.prepare("SELECT count(*) FROM options WHERE name LIKE 'fts_backfill_%'")
				.pluck()
				.get()
		).to.equal(0);
	});

	it("should index live messages and deletes while it builds", async function () {
		const store = await open();

		await store.index(
			{uuid: "net"} as Network,
			{name: "#second"} as Channel,
			new Msg({
				type: MessageType.MESSAGE,
				time: new Date(1800000000000),
				text: "a brand new line",
			})
		);
		await store.deleteChannel({uuid: "net"}, {name: "#first"});
		await store.finishSearchIndex();

		const left = store.database
			.prepare("SELECT count(*) FROM messages WHERE type = 'message'")
			.pluck()
			.get() as number;

		expect(indexed(store, "line")).to.equal(left);
		expect(await search(store, "brand new")).to.deep.equal(["a brand new line"]);
		expect(await search(store, "line 12")).to.deep.equal([]);
		store.database.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
	});

	it("should continue where it left off after a restart", async function () {
		const first = await open();
		const backfill = () => (first as unknown as {backfill: {rows: number}}).backfill;

		// Two small steps; the step size would otherwise grow to fit 40ms
		for (let step = 0; step < 2; step++) {
			backfill().rows = 500;
			first.buildSearchIndexStep();
		}

		await first.close();

		const store = await open();
		expect(store.searchIndexReady).to.equal(false);
		expect(indexed(store, "stored line")).to.be.within(1, searchable - 1);

		await store.finishSearchIndex();
		expect(indexed(store, "stored line")).to.equal(searchable);
		expect(await search(store, "line 2999")).to.deep.equal([]);
		expect(await search(store, "line 2998")).to.deep.equal(["stored line 2998"]);
	});

	it("should report how far the index is and how searches went", async function () {
		const store = await open();
		const backfill = () => (store as unknown as {backfill: {rows: number}}).backfill;

		backfill().rows = 1000;
		store.buildSearchIndexStep();

		const building = store.searchIndexState();
		expect(building.state).to.equal("building");
		expect(building.progress).to.be.within(0.2, 0.5);
		expect(building.remaining).to.be.within(1, total);

		await search(store, "line 1234");
		expect(store.lastSearchStats).to.include({
			strategy: "scan",
			reason: "index-building",
			candidates: null,
			results: 1,
		});

		await store.finishSearchIndex();
		expect(store.searchIndexState()).to.deep.equal({state: "complete"});

		await search(store, "line 1234");
		expect(store.lastSearchStats).to.include({strategy: "lookup", results: 1});
		expect(store.lastSearchStats!.reason).to.equal(undefined);
		expect(store.lastSearchStats!.candidates).to.be.at.least(1);

		await search(store, "li");
		expect(store.lastSearchStats).to.include({strategy: "scan", reason: "short-term"});
	});

	it("should report a failed index build", async function () {
		const store = await open();
		// Make the next step fail: the index can't be written to
		store.database.exec("DROP TABLE messages_fts");

		for (let i = 0; i < 100 && store.searchIndexState().state === "building"; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}

		const failed = store.searchIndexState();
		expect(failed.state).to.equal("failed");
		expect(failed.error).to.match(/messages_fts/);

		await search(store, "line 1234");
		expect(store.lastSearchStats).to.include({strategy: "scan", reason: "index-failed"});
	});

	it("should report database stats and time disk reads", async function () {
		const store = await open();
		await store.finishSearchIndex();
		const stats = await store.databaseStats();

		expect(stats.maxRowId).to.equal(total);
		expect(stats.fileBytes).to.be.greaterThan(0);
		expect(stats.pages).to.be.greaterThan(0);
		expect(stats.journalMode).to.equal("wal");
		expect(stats.schemaVersion).to.be.greaterThan(0);
		expect(stats.pendingClears).to.equal(0);

		const disk = await store.probeDisk(8);
		expect(disk.reads).to.equal(8);
		expect(disk.medianMs).to.be.at.most(disk.p90Ms);
		expect(disk.p90Ms).to.be.at.most(disk.maxMs);
	});
});

describe("SQLite clearing history", function () {
	this.timeout(20000);
	let dir: string;
	let file: string;
	const stores: MessageStorage[] = [];
	const total = 2000;
	const net = testNet("net");
	const big = testChan("#Big");
	const other = testChan("#other");

	const open = async () => {
		const store = new MessageStorage("clear");
		stores.push(store);
		await store._enable(file);
		store.initDone.resolve();
		return store;
	};

	// Three in four lines go to #big
	beforeEach(async function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "thelounge-clear-"));
		file = path.join(dir, "user.sqlite3");
		const store = await open();

		for (let i = 0; i < total; i++) {
			await store.index(
				net,
				i % 4 === 3 ? other : big,
				new Msg({time: new Date(1700000000000 + i), text: `line ${i}`})
			);
		}

		await store.close();
	});

	afterEach(async function () {
		for (const store of stores.splice(0)) {
			await store.close();
		}

		fs.rmSync(dir, {recursive: true, force: true});
	});

	// Steps of 100 rows, so that clearing #big takes several
	const smallSteps = (store: MessageStorage) => {
		(store as unknown as {clearRows: number}).clearRows = 100;
	};

	const stored = (store: MessageStorage, chan: Channel) =>
		store.database
			.prepare("SELECT count(*) FROM messages WHERE channel = ?")
			.pluck()
			.get(chan.name.toLowerCase()) as number;

	const texts = async (store: MessageStorage, chan: Channel) =>
		(await store.getMessages(net, chan, () => undefined)).map((m) => m.text);

	const search = async (store: MessageStorage, term: string, channelName = "") =>
		(
			await store.search({searchTerm: term, networkUuid: "net", channelName, offset: 0})
		).results.map((m) => m.text);

	const pending = (store: MessageStorage) =>
		store.database
			.prepare("SELECT value FROM options WHERE name = 'history_clears'")
			.pluck()
			.get() as string | undefined;

	// The index's own merging, off while deleting
	const merging = (store: MessageStorage) =>
		Object.fromEntries(
			(
				store.database
					.prepare(
						"SELECT k, v FROM messages_fts_config WHERE k IN ('automerge', 'deletemerge')"
					)
					.all() as {k: string; v: number}[]
			).map((row) => [row.k, row.v])
		);

	it("should clear a short history right away", async function () {
		const store = await open();
		await store.deleteChannel(net, other);

		expect(stored(store, other)).to.equal(0);
		expect(stored(store, big)).to.equal(total * 0.75);

		// What may be left is tidying up the index
		await store.finishClearingHistory();
		expect(pending(store)).to.equal(undefined);
		expect(merging(store)).to.deep.equal({automerge: 4, deletemerge: 10});
		store.database.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
	});

	it("should hide a long history at once and delete it in the background", async function () {
		const store = await open();
		smallSteps(store);
		await store.deleteChannel(net, big);

		// One step in: most rows are still stored, none of them shows
		expect(stored(store, big)).to.be.within(1, total * 0.75 - 1);
		expect(pending(store)).to.be.a("string");
		expect(merging(store)).to.deep.equal({automerge: 0, deletemerge: 0});
		expect(await texts(store, big)).to.deep.equal([]);
		expect(await store.getMessagesBefore("net", "#Big", 1800000000000, 50)).to.deep.equal([]);
		expect(await store.getMessagesAfter("net", "#big", 0, 50)).to.deep.equal([]);
		expect(
			(await store.getMessagesAround("net", "#big", 1700000001000, 50)).messages
		).to.deep.equal([]);
		expect(await search(store, "line 1000")).to.deep.equal([]);
		expect(await search(store, "line", "#big")).to.deep.equal([]);
		expect(await search(store, "line 1003")).to.deep.equal(["line 1003"]);
		expect(await texts(store, other)).to.have.lengthOf(total / 4);

		// What is said from now on stays
		await store.index(net, big, new Msg({time: new Date(1800000000000), text: "after it"}));
		expect(await texts(store, big)).to.deep.equal(["after it"]);
		expect(await search(store, "after it")).to.deep.equal(["after it"]);

		// Left to its timers, it finishes on its own
		for (let i = 0; i < 400 && pending(store) !== undefined; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}

		expect(stored(store, big)).to.equal(1);
		expect(await texts(store, big)).to.deep.equal(["after it"]);
		expect(await texts(store, other)).to.have.lengthOf(total / 4);
		expect(pending(store)).to.equal(undefined);
		expect(merging(store)).to.deep.equal({automerge: 4, deletemerge: 10});

		// The index lost exactly the deleted rows
		expect(
			store.database
				.prepare("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH ?")
				.pluck()
				.get(trigramQuery("line"))
		).to.equal(total / 4);
		store.database.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
	});

	it("should carry on after a restart", async function () {
		const first = await open();
		smallSteps(first);
		await first.deleteChannel(net, big);
		await first.close();

		const store = await open();
		expect(stored(store, big)).to.be.above(0);
		expect(await texts(store, big)).to.deep.equal([]);

		await store.finishClearingHistory();
		expect(stored(store, big)).to.equal(0);
		expect(await texts(store, other)).to.have.lengthOf(total / 4);
		expect(pending(store)).to.equal(undefined);
	});

	it("should also hide what was said in between when cleared again", async function () {
		const store = await open();
		smallSteps(store);
		await store.deleteChannel(net, big);
		await store.index(net, big, new Msg({time: new Date(1800000000000), text: "in between"}));
		expect(await texts(store, big)).to.deep.equal(["in between"]);

		await store.deleteChannel(net, big);
		expect(await texts(store, big)).to.deep.equal([]);

		await store.finishClearingHistory();
		expect(stored(store, big)).to.equal(0);
		expect(await texts(store, other)).to.have.lengthOf(total / 4);
	});
});

describe("SQLite Message Storage", function () {
	// Increase timeout due to unpredictable I/O on CI services
	this.timeout(util.isRunningOnCI() ? 25000 : 5000);
	this.slow(300);

	const expectedPath = path.join(Config.getHomePath(), "logs", "testUser.sqlite3");
	let store: MessageStorage;

	function db_get_one(stmt: string, ...params: SqlValue[]): Promise<Record<string, SqlValue>> {
		try {
			const row = store.database.prepare(stmt).get(...params) as Record<string, SqlValue>;
			return Promise.resolve(row);
		} catch (err) {
			return Promise.reject(err instanceof Error ? err : new Error(String(err)));
		}
	}

	before(function (done) {
		store = new MessageStorage("testUser");

		// Delete database file from previous test run
		if (fs.existsSync(expectedPath)) {
			fs.unlink(expectedPath, done);
		} else {
			done();
		}
	});

	after(function (done) {
		// After tests run, remove the logs folder
		// so we return to the clean state
		fs.unlinkSync(expectedPath);
		fs.rmdir(path.join(Config.getHomePath(), "logs"), done);
	});

	it("should create database file", async function () {
		expect(store.isEnabled).to.equal(false);
		expect(fs.existsSync(expectedPath)).to.equal(false);

		await store.enable();
		expect(store.isEnabled).to.equal(true);
	});

	it("should resolve an empty array when disabled", async function () {
		store.isEnabled = false;
		// When disabled, getMessages returns empty array without using params
		const dummyNet = testNet("disabled-test");
		const dummyChan = testChan("#disabled-test");
		const messages = await store.getMessages(dummyNet, dummyChan, () => 0);
		expect(messages).to.have.lengthOf(0);
		store.isEnabled = true;
	});

	it("should insert schema version to options table", async function () {
		const row = await db_get_one("SELECT value FROM options WHERE name = 'schema_version'");
		expect(row.value).to.equal(currentSchemaVersion.toString());
	});

	it("should insert migrations", async function () {
		const row = await db_get_one(
			"SELECT id, version FROM migrations WHERE version = ?",
			currentSchemaVersion
		);
		expect(row).to.not.equal(undefined);
	});

	it("should store and return multi-statement rollbacks in order", async function () {
		const multi = rollbacks.filter((r) => r.stmts.length > 1);
		expect(multi).to.have.length.greaterThan(0);

		const stored = await store.fetch_rollbacks(0);

		for (const rollback of multi) {
			const rows = store.database
				.prepare(
					`select step from rollback_steps
					join migrations on migrations.id = rollback_steps.migration_id
					where version = ? order by rollback_steps.id`
				)
				.all(rollback.version) as {step: number}[];
			const steps = rows.map((row) => row.step);
			expect(steps).to.deep.equal(rollback.stmts.map((_, i) => i));

			const found = stored.find((r) => r.version === rollback.version);
			expect(found?.stmts).to.deep.equal(rollback.stmts);
		}
	});

	it("should return rollback steps stored with step 0 in insertion order", async function () {
		// Older builds stored every step of a rollback with step 0
		const version = currentSchemaVersion + 1;
		const stmts = ["select 3", "select 1", "select 2", "select 0"];
		const migration = store.database
			.prepare("insert into migrations (version) values (?) returning id")
			.get(version) as {id: number};
		const insertStep = store.database.prepare(
			"insert into rollback_steps (migration_id, step, statement) values (?, 0, ?)"
		);

		for (const stmt of stmts) {
			insertStep.run(migration.id, stmt);
		}

		try {
			const stored = await store.fetch_rollbacks(currentSchemaVersion);
			expect(stored).to.deep.equal([{version, rollback_forbidden: false, stmts}]);
		} finally {
			store.database
				.prepare("delete from rollback_steps where migration_id = ?")
				.run(migration.id);
			store.database.prepare("delete from migrations where id = ?").run(migration.id);
		}
	});

	it("should store a message", async function () {
		await store.index(
			{uuid: "this-is-a-network-guid"} as Network,
			{name: "#thisISaCHANNEL"} as Channel,
			new Msg({
				time: new Date(123456789),
				text: "Hello from sqlite world!",
			})
		);
	});

	it("should retrieve previously stored message", async function () {
		let msgid = 0;
		const messages = await store.getMessages(
			{
				uuid: "this-is-a-network-guid",
			} as Network,
			{
				name: "#thisisaCHANNEL",
			} as Channel,
			() => msgid++
		);
		expect(messages).to.have.lengthOf(1);
		const msg = messages[0];
		expect(msg.text).to.equal("Hello from sqlite world!");
		expect(msg.type).to.equal(MessageType.MESSAGE);
		expect(msg.time.getTime()).to.equal(123456789);
	});

	it("should not bring back queued messages after deleting a channel", async function () {
		const net = testNet("delete-queued-network");
		const chan = testChan("#queued");

		// Still in the batch queue when the channel is deleted
		await store.index(net, chan, new Msg({time: new Date(123456789), text: "queued"}));
		await store.deleteChannel(net, chan);

		// Reading flushes whatever is still queued
		const messages = await store.getMessages(net, chan, () => 0);
		expect(messages).to.have.lengthOf(0);

		// Also once the rows are really gone, and the clear is done for the tests after
		await store.finishClearingHistory();
		expect(await store.getMessages(net, chan, () => 0)).to.have.lengthOf(0);
	});

	it("should retrieve latest LIMIT messages in order", async function () {
		const originalMaxHistory = Config.values.maxHistory;

		try {
			Config.values.maxHistory = 2;

			for (let i = 0; i < 200; ++i) {
				await store.index(
					{uuid: "retrieval-order-test-network"} as Network,
					{name: "#channel"} as Channel,
					new Msg({
						time: new Date(123456789 + i),
						text: `msg ${i}`,
					})
				);
			}

			let msgId = 0;
			const messages = await store.getMessages(
				{uuid: "retrieval-order-test-network"} as Network,
				{name: "#channel"} as Channel,
				() => msgId++
			);
			expect(messages).to.have.lengthOf(2);
			expect(messages.map((i_1) => i_1.text)).to.deep.equal(["msg 198", "msg 199"]);
		} finally {
			Config.values.maxHistory = originalMaxHistory;
		}
	});

	it("should search messages", async function () {
		const originalMaxHistory = Config.values.maxHistory;

		try {
			Config.values.maxHistory = 2;

			const search = await store.search({
				searchTerm: "msg",
				networkUuid: "retrieval-order-test-network",
				channelName: "",
				offset: 0,
			});
			expect(search.results).to.have.lengthOf(100);
			const expectedMessages: string[] = [];

			for (let i = 100; i < 200; ++i) {
				expectedMessages.push(`msg ${i}`);
			}

			expect(search.results.map((i_1) => i_1.text)).to.deep.equal(expectedMessages);
		} finally {
			Config.values.maxHistory = originalMaxHistory;
		}
	});

	it("should search messages with escaped wildcards", async function () {
		async function assertResults(query: string, expected: string[]) {
			const search = await store.search({
				searchTerm: query,
				networkUuid: "this-is-a-network-guid2",
				channelName: "",
				offset: 0,
			});
			expect(search.results.map((i) => i.text)).to.deep.equal(expected);
		}

		const originalMaxHistory = Config.values.maxHistory;

		try {
			Config.values.maxHistory = 3;

			await store.index(
				{uuid: "this-is-a-network-guid2"} as Network,
				{name: "#channel"} as Channel,
				new Msg({
					time: new Date(123456790),
					text: `foo % bar _ baz`,
				})
			);

			await store.index(
				{uuid: "this-is-a-network-guid2"} as Network,
				{name: "#channel"} as Channel,
				new Msg({
					time: new Date(123456791),
					text: `foo bar x baz`,
				})
			);

			await store.index(
				{uuid: "this-is-a-network-guid2"} as Network,
				{name: "#channel"} as Channel,
				new Msg({
					time: new Date(123456792),
					text: `bar @ baz`,
				})
			);

			await assertResults("foo", ["foo % bar _ baz", "foo bar x baz"]);
			await assertResults("%", ["foo % bar _ baz"]);
			await assertResults("foo % bar ", ["foo % bar _ baz"]);
			await assertResults("_", ["foo % bar _ baz"]);
			await assertResults("bar _ baz", ["foo % bar _ baz"]);
			await assertResults("%%", []);
			await assertResults("@%", []);
			await assertResults("@", ["bar @ baz"]);
		} finally {
			Config.values.maxHistory = originalMaxHistory;
		}
	});

	it("should serve channel history from the composite index", function () {
		const plan = store.database
			.prepare(
				"EXPLAIN QUERY PLAN SELECT id FROM messages WHERE network = ? AND channel = ? ORDER BY time DESC, id DESC LIMIT ?"
			)
			.all("a", "b", 1)
			.map((row) => (row as {detail: string}).detail)
			.join(" | ");

		expect(plan).to.include("network_channel_time");
		expect(plan).to.not.include("TEMP B-TREE"); // i.e. no sort of the whole channel
	});

	it("should page older messages without losing same-millisecond rows", async function () {
		const net = {uuid: "paging-network"} as Network;
		const chan = {name: "#paging"} as Channel;

		// ids are set the way Chan.pushMessage() would, three rows share time 2000
		for (const [id, time] of [
			[101, 1000],
			[102, 2000],
			[103, 2000],
			[104, 2000],
			[105, 3000],
		]) {
			const msg = new Msg({time: time as unknown as Date, text: `paged ${id}`});
			msg.id = id;
			await store.index(net, chan, msg);
		}

		const strict = await store.getMessagesBefore(net.uuid, chan.name, 2000, 10);
		expect(strict.map((m) => m.id)).to.deep.equal([101]);

		const inclusive = await store.getMessagesBefore(net.uuid, chan.name, 2000, 10, true);
		expect(inclusive.map((m) => m.id)).to.deep.equal([101, 102, 103, 104]);

		// newest rows win when the limit cuts the page short, oldest first
		const limited = await store.getMessagesBefore(net.uuid, chan.name, 3000, 2, true);
		expect(limited.map((m) => m.id)).to.deep.equal([104, 105]);
	});

	it("should return the history around a point and say what lies beyond", async function () {
		const net = {uuid: "around-network"} as Network;
		const chan = {name: "#around"} as Channel;

		for (let i = 1; i <= 10; i++) {
			const msg = new Msg({time: new Date(i * 1000), text: `around ${i}`});
			msg.id = 500 + i;
			await store.index(net, chan, msg);
		}

		const middle = await store.getMessagesAround(net.uuid, chan.name, 5000, 4);
		expect(middle.messages.map((m) => m.text)).to.deep.equal([
			"around 4",
			"around 5",
			"around 6",
			"around 7",
		]);
		expect(middle.hasMoreBefore).to.equal(true);
		expect(middle.hasMoreAfter).to.equal(true);

		const start = await store.getMessagesAround(net.uuid, chan.name, 2000, 4);
		expect(start.messages.map((m) => m.text)).to.deep.equal([
			"around 1",
			"around 2",
			"around 3",
			"around 4",
		]);
		expect(start.hasMoreBefore).to.equal(false);
		expect(start.hasMoreAfter).to.equal(true);

		const end = await store.getMessagesAround(net.uuid, chan.name, 9000, 4);
		expect(end.messages.map((m) => m.text)).to.deep.equal([
			"around 8",
			"around 9",
			"around 10",
		]);
		expect(end.hasMoreBefore).to.equal(true);
		expect(end.hasMoreAfter).to.equal(false);

		const after = await store.getMessagesAfter(net.uuid, chan.name, 8000, 2);
		expect(after.map((m) => m.id)).to.deep.equal([508, 509]);
	});

	it("should report the highest id it has stored", async function () {
		const msg = new Msg({time: 4000 as unknown as Date, text: "high id"});
		msg.id = 987654;
		await store.index({uuid: "paging-network"} as Network, {name: "#paging"} as Channel, msg);

		expect(await store.getMaxMessageId()).to.equal(987654);
	});

	it("should build index queries out of trigrams", function () {
		expect(trigramQuery("ab")).to.equal(null);
		expect(trigramQuery("abc")).to.equal('"abc"');
		expect(trigramQuery("abcd")).to.equal('"abc" AND "bcd"');
		expect(trigramQuery("aaaa")).to.equal('"aaa"');
		expect(trigramQuery('a"b c')).to.equal('"a""b" AND """b " AND "b c"');
		// counted by character, not by UTF-16 unit
		expect(trigramQuery("a😀b")).to.equal('"a😀b"');
		expect(trigramQuery("😀b")).to.equal(null);
	});

	// The tests below share these messages and run in order
	const ftsNet = {uuid: "fts-network"} as Network;
	const ftsChan = {name: "#fts"} as Channel;
	const ftsOther = {name: "#fts-other"} as Channel;
	const defaultLimits = {...searchLimits};

	async function find(searchTerm: string, channelName: string) {
		const {results} = await store.search({
			searchTerm,
			networkUuid: ftsNet.uuid,
			channelName,
			offset: 0,
		});

		return results.map((m) => m.text);
	}

	// Runs a search through all three strategies and insists they agree
	async function findEveryWay(searchTerm: string, channelName = ftsChan.name) {
		const found: (string | undefined)[][] = [];

		try {
			for (const limits of [
				defaultLimits,
				{direct: 0, filter: 1000},
				{direct: 0, filter: 0},
			]) {
				Object.assign(searchLimits, limits);
				found.push(await find(searchTerm, channelName));
			}
		} finally {
			Object.assign(searchLimits, defaultLimits);
		}

		expect(found[1]).to.deep.equal(found[0], `filtered walk differs for "${searchTerm}"`);
		expect(found[2]).to.deep.equal(found[0], `plain walk differs for "${searchTerm}"`);

		return found[0];
	}

	function indexHits(term: string) {
		return store.database
			.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?")
			.all(trigramQuery(term)).length;
	}

	it("should find the same messages whichever search strategy runs", async function () {
		const texts = [
			"The quick brown fox",
			"quick thinking saves the day",
			'she said "quick" twice',
			"Grüße aus München",
			"100% sure_thing @home",
			"ok",
			"quick quick quick",
		];

		for (const [i, text] of texts.entries()) {
			await store.index(ftsNet, ftsChan, new Msg({time: new Date(5000 + i), text}));
		}

		await store.index(
			ftsNet,
			ftsOther,
			new Msg({time: new Date(6000), text: "quick, elsewhere"})
		);
		await store.index(
			ftsNet,
			ftsChan,
			new Msg({time: new Date(6001), text: "quick join", type: MessageType.JOIN})
		);

		expect(await findEveryWay("quick")).to.deep.equal([
			"The quick brown fox",
			"quick thinking saves the day",
			'she said "quick" twice',
			"quick quick quick",
		]);
		expect(await findEveryWay("QUICK BROWN")).to.deep.equal(["The quick brown fox"]);
		expect(await findEveryWay('"quick"')).to.deep.equal(['she said "quick" twice']);
		expect(await findEveryWay("München")).to.deep.equal(["Grüße aus München"]);
		expect(await findEveryWay("100%")).to.deep.equal(["100% sure_thing @home"]);
		expect(await findEveryWay("sure_thing @h")).to.deep.equal(["100% sure_thing @home"]);
		expect(await findEveryWay("sureXthing")).to.deep.equal([]);
		expect(await findEveryWay("nowhere to be found")).to.deep.equal([]);
		// too short for the index, still found
		expect(await findEveryWay("ok")).to.deep.equal(["ok"]);
	});

	it("should keep searches inside their channel", async function () {
		expect(await findEveryWay("elsewhere")).to.deep.equal([]);
		expect(await findEveryWay("elsewhere", ftsOther.name)).to.deep.equal(["quick, elsewhere"]);
	});

	it("should only index plain messages", async function () {
		expect(await findEveryWay("quick join")).to.deep.equal([]);
		expect(indexHits("quick join")).to.equal(0);
	});

	it("should narrow a search down with the index", function () {
		expect(indexHits("brown fox")).to.equal(1);
		expect(indexHits("nowhere to be found")).to.equal(0);
	});

	it("should drop deleted messages from the index", async function () {
		const before = indexHits("quick");
		await store.deleteChannel(ftsNet, ftsOther);
		await store.finishClearingHistory();

		expect(indexHits("quick")).to.equal(before - 1);
		expect(await findEveryWay("elsewhere", ftsOther.name)).to.deep.equal([]);
	});

	it("should index existing messages when migrating", async function () {
		// Take the index away the way an older build rolling back would
		const previous = migrations[migrations.length - 2].version;
		await store.downgrade_to(previous);
		store.database
			.prepare("UPDATE options SET value = ? WHERE name = 'schema_version'")
			.run(previous.toString());

		expect(
			store.database
				.prepare("SELECT name FROM sqlite_master WHERE name = 'messages_fts'")
				.all()
		).to.have.lengthOf(0);

		await store.run_migrations();

		// Indexed in the background; search reads the messages until then
		expect(store.searchIndexReady).to.equal(false);
		expect(await findEveryWay("brown fox")).to.deep.equal(["The quick brown fox"]);

		await store.finishSearchIndex();

		expect(store.searchIndexReady).to.equal(true);
		expect(indexHits("brown fox")).to.equal(1);
		expect(await findEveryWay("brown fox")).to.deep.equal(["The quick brown fox"]);
	});

	it("should be able to downgrade", async function () {
		for (const rollback of rollbacks.slice().reverse()) {
			if (rollback.rollback_forbidden) {
				throw Error(
					"Try to write a down migration, if you really can't, flip this to a break"
				);
			}

			const new_version = await store.downgrade_to(rollback.version);
			expect(new_version).to.equal(rollback.version);
		}
	});

	it("should close database", async function () {
		await store.close();
		expect(fs.existsSync(expectedPath)).to.equal(true);
	});
});

function dateAddDays(date: Date, days: number) {
	const ret = new Date(date.valueOf());
	ret.setDate(date.getDate() + days);
	return ret;
}
