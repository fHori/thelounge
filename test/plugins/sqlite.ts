import fs from "fs";
import os from "os";
import path from "path";
import {expect} from "vitest";
import Msg from "../../server/models/msg.js";
import {MessageType} from "../../shared/types/msg.js";
import Config from "../../server/config.js";
import MessageStorage, {
	applyMigrationStep,
	currentSchemaVersion,
	migrations,
	necessaryMigrations,
	rollbacks,
	searchLimits,
	namedSchemaVersions,
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

	beforeAll(async function () {
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

	afterAll(function () {
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
			applyMigrationStep(db, stmt);
		}

		await serialize_run("COMMIT TRANSACTION");
	});

	it("migrated database serves history from the index", function () {
		const plan = db
			.prepare(
				"EXPLAIN QUERY PLAN SELECT id, msg, type, time, msgid FROM messages WHERE network = ? AND channel = ? ORDER BY time DESC, id DESC LIMIT ?"
			)
			.all("8f650427-79a2-4950-b8af-94088b61b37c", "##linux", 100) as {detail: string}[];

		const details = plan.map((row) => row.detail).join("\n");
		expect(details).to.include("USING INDEX network_channel_time");
		expect(details).to.not.include("TEMP B-TREE");
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

describe("SQLite downgrades", function () {
	let store: MessageStorage;

	// Every table and index, without the ones SQLite manages itself
	const schemaObjects = () =>
		(
			store.database
				.prepare(
					"SELECT type || ' ' || name AS o FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name"
				)
				.pluck()
				.all() as string[]
		).sort();

	beforeEach(async function () {
		store = new MessageStorage("testUser");
		await store._enable(":memory:");
		store.initDone.resolve();
	});

	afterEach(async function () {
		await store.close();
	});

	it("should store rollback steps in order", function () {
		const steps = store.database
			.prepare(
				"SELECT step FROM rollback_steps JOIN migrations ON migrations.id = rollback_steps.migration_id WHERE version = ? ORDER BY rollback_steps.id"
			)
			.pluck()
			.all(currentSchemaVersion);

		expect(steps).to.deep.equal(
			rollbacks.find((r) => r.version === currentSchemaVersion)!.stmts.map((_, i) => i)
		);
	});

	// What each build creates for a new database, besides the four tables
	const plainColumns = ["id", "network", "channel", "time", "type", "msg"];
	const targets = [
		{
			name: "stock",
			version: namedSchemaVersions.stock,
			indexes: ["msg_type_idx", "network_channel_time", "time"],
			columns: plainColumns,
		},
		{
			name: "stock-4.6",
			version: namedSchemaVersions["stock-4.6"],
			indexes: ["msg_type_idx", "msgid_idx", "network_channel_time", "time"],
			columns: [...plainColumns, "msgid"],
		},
		{
			name: "tetra",
			version: namedSchemaVersions.tetra,
			indexes: ["msg_type_idx", "network_channel", "time"],
			columns: plainColumns,
		},
	];

	const expectSchemaOf = async (target: (typeof targets)[number]) => {
		expect(schemaObjects()).to.deep.equal(
			[
				...target.indexes.map((i) => `index ${i}`),
				"table messages",
				"table migrations",
				"table options",
				"table rollback_steps",
			].sort()
		);
		expect(
			(store.database.prepare("PRAGMA table_info(messages)").all() as {name: string}[]).map(
				(c) => c.name
			)
		).to.deep.equal(target.columns);

		// The version an older build checks before it opens the database
		expect(await store.current_version()).to.equal(target.version);

		// Nothing left over that a later upgrade could trip over
		expect(
			store.database.prepare("SELECT max(version) FROM migrations").pluck().get()
		).to.equal(target.version);
		expect(
			store.database
				.prepare(
					"SELECT count(*) FROM rollback_steps WHERE migration_id NOT IN (SELECT id FROM migrations)"
				)
				.pluck()
				.get()
		).to.equal(0);
	};

	for (const target of targets) {
		it(`should leave exactly the ${target.name} schema behind`, async function () {
			expect(await store.downgrade_to(target.version)).to.equal(target.version);
			await expectSchemaOf(target);
		});

		it(`should downgrade a database upgraded before stock 4.5's migration to ${target.name}`, async function () {
			// What this fork stored before it took over 1780272000000: no row
			// for it, and the old rollback of its own index migration
			const own = store.database
				.prepare("SELECT id FROM migrations WHERE version = 1794816000000")
				.pluck()
				.get();
			store.database.exec(
				"DELETE FROM rollback_steps WHERE migration_id IN (SELECT id FROM migrations WHERE version = 1780272000000)"
			);
			store.database.exec("DELETE FROM migrations WHERE version = 1780272000000");
			store.database
				.prepare(
					"INSERT INTO rollback_steps (migration_id, step, statement) VALUES (?, 0, 'CREATE INDEX network_channel ON messages (network, channel)'), (?, 1, 'DROP INDEX network_channel_time')"
				)
				.run(own, own);

			await store.downgrade_to(target.version);
			await expectSchemaOf(target);
		});
	}

	it("should migrate forward again after a downgrade", async function () {
		const upToDate = schemaObjects();

		for (const target of targets) {
			await store.downgrade_to(target.version);
			await store.run_migrations();

			expect(await store.current_version()).to.equal(currentSchemaVersion);
			expect(schemaObjects()).to.deep.equal(upToDate);
		}
	});

	it("should stop a background index build and keep search working", async function () {
		await store.index(
			{uuid: "net"} as Network,
			{name: "#chan"} as Channel,
			new Msg({type: MessageType.MESSAGE, time: new Date(1700000000000), text: "kept line"})
		);

		// Leave the index to be built in the background, then go back down,
		// with that message still waiting in the write batch. Stock 4.6 keeps
		// the msgid column, which search on an open store reads.
		const target = namedSchemaVersions["stock-4.6"];
		await store.downgrade_to(target);
		await store.run_migrations();
		expect(store.searchIndexReady).to.equal(false);
		await store.downgrade_to(target);

		expect(store.searchIndexReady).to.equal(false);
		const found = await store.search({
			searchTerm: "kept",
			networkUuid: "net",
			channelName: "#chan",
			offset: 0,
		});
		expect(found.results.map((m) => m.text)).to.deep.equal(["kept line"]);

		// Nothing left scheduled to run into the dropped tables
		await new Promise((r) => setTimeout(r, 50));
		await expectSchemaOf(targets[1]);
	});

	it("should go from stock 4.6 down to stock 4.5, then tetra", async function () {
		await store.downgrade_to(namedSchemaVersions["stock-4.6"]);
		await expectSchemaOf(targets[1]);
		await store.downgrade_to(namedSchemaVersions.stock);
		await expectSchemaOf(targets[0]);
		await store.downgrade_to(namedSchemaVersions.tetra);
		await expectSchemaOf(targets[2]);
	});

	it("should refuse versions it can't downgrade to", async function () {
		const attempt = async (version: number) => {
			try {
				await store.downgrade_to(version);
			} catch (e) {
				return (e as Error).message;
			}

			return null;
		};

		expect(await attempt(0)).to.match(/not a valid version/);
		expect(await attempt(1234)).to.match(/not a valid version/);

		await store.downgrade_to(namedSchemaVersions.tetra);
		expect(await attempt(currentSchemaVersion)).to.match(/already older/);
		expect(await store.current_version()).to.equal(namedSchemaVersions.tetra);
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

// The messages table as stock The Lounge 4.6 creates it
const stock46Messages =
	"CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, network TEXT, channel TEXT, time INTEGER, type TEXT, msg TEXT, msgid TEXT)";

// What stock The Lounge 4.6 stores to roll its msgid migration back
const stock46MsgidRollback = {
	version: 1784073600000,
	stmts: ["DROP INDEX msgid_idx", "ALTER TABLE messages DROP COLUMN msgid"],
};

type OtherBuild = {
	name: string;
	version: number;
	tables?: string[];
	indexes: string[];
	// What it recorded for the migrations after stock 4.5's
	extraRollbacks?: {version: number; stmts: string[]}[];
};

const otherBuilds: OtherBuild[] = [
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
	{
		name: "stock The Lounge 4.6",
		version: 1784073600000,
		tables: [baseTables[0], stock46Messages, baseTables[2], baseTables[3]],
		indexes: [
			"CREATE INDEX time ON messages (time)",
			"CREATE INDEX msg_type_idx on messages (type)",
			"CREATE INDEX network_channel_time ON messages (network, channel, time)",
			"CREATE INDEX msgid_idx ON messages (msgid)",
		],
		extraRollbacks: [stock46MsgidRollback],
	},
];

// Writes a database the way `build` left it, with 20 messages in net/#chan
function createOtherBuildDb(file: string, build: OtherBuild) {
	const db = new Database(file);

	for (const stmt of [...(build.tables ?? baseTables), ...build.indexes]) {
		db.exec(stmt);
	}

	db.prepare("INSERT INTO options (name, value) VALUES ('schema_version', ?)").run(
		build.version.toString()
	);

	// The rollbacks it stored for each migration it ran. Up to stock 4.5
	// they're the same everywhere; what each build stored after that is
	// listed with it.
	const stored = [
		...rollbacks.filter((r) => r.version <= Math.min(build.version, 1780272000000)),
		...(build.extraRollbacks ?? []),
	];

	for (const rollback of stored) {
		const migration = db
			.prepare("INSERT INTO migrations (version) VALUES (?) RETURNING id")
			.get(rollback.version) as {id: number};

		for (const [step, stmt] of rollback.stmts.entries()) {
			db.prepare(
				"INSERT INTO rollback_steps (migration_id, step, statement) VALUES (?, ?, ?)"
			).run(migration.id, step, stmt);
		}
	}

	const hasMsgid = (db.prepare("PRAGMA table_info(messages)").all() as {name: string}[]).some(
		(c) => c.name === "msgid"
	);

	for (let i = 0; i < 20; i++) {
		const time = 1700000000000 + i;
		const msg = JSON.stringify({text: `old message ${i}`});

		if (hasMsgid) {
			db.prepare(
				"INSERT INTO messages (network, channel, time, type, msg, msgid) VALUES ('net', '#chan', ?, 'message', ?, ?)"
			).run(time, msg, `old-msgid-${i}`);
		} else {
			db.prepare(
				"INSERT INTO messages (network, channel, time, type, msg) VALUES ('net', '#chan', ?, 'message', ?)"
			).run(time, msg);
		}
	}

	db.close();
}

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
			createOtherBuildDb(file, build);

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
				).to.deep.equal(["msg_type_idx", "msgid_idx", "network_channel_time", "time"]);

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

// This fork's last schema before the msgid column. DO NOT CHANGE, it has to
// match what that build wrote.
const forkBeforeMsgid: OtherBuild = {
	name: "this fork before msgid",
	version: 1794820000000,
	indexes: [
		...otherBuilds[1].indexes,
		"CREATE VIRTUAL TABLE messages_fts USING fts5(text, tokenize='trigram', detail=none, content='', contentless_delete=1)",
		"CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages WHEN old.type = 'message' BEGIN DELETE FROM messages_fts WHERE rowid = old.id; END",
	],
	extraRollbacks: [
		{version: 1794816000000, stmts: []},
		rollbacks.find((r) => r.version === 1794820000000)!,
	],
};

describe("SQLite msgid column", function () {
	let dir: string;
	let file: string;
	const stores: MessageStorage[] = [];
	const net = testNet("net");
	const chan = testChan("#chan");

	beforeEach(function () {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "thelounge-msgid-"));
		file = path.join(dir, "user.sqlite3");
	});

	afterEach(async function () {
		for (const store of stores.splice(0)) {
			await store.close();
		}

		fs.rmSync(dir, {recursive: true, force: true});
	});

	const open = async () => {
		const store = new MessageStorage("msgid");
		stores.push(store);
		await store._enable(file);
		store.initDone.resolve();
		return store;
	};

	const columns = (store: MessageStorage) =>
		(store.database.prepare("PRAGMA table_info(messages)").all() as {name: string}[]).map(
			(c) => c.name
		);

	const hasIndex = (store: MessageStorage) =>
		store.database
			.prepare(
				"SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'msgid_idx'"
			)
			.pluck()
			.get() === 1;

	// Stores a message with a msgid and reads it back
	async function roundTrip(store: MessageStorage) {
		const msg = new Msg({time: new Date(1800000000000), text: "with an id"});
		msg.msgid = "new-msgid";
		await store.index(net, chan, msg);

		const messages = await store.getMessages(net, chan, () => undefined);
		const last = messages[messages.length - 1];
		expect(last.text).to.equal("with an id");
		expect(last.msgid).to.equal("new-msgid");

		// Kept in its column, not in the message JSON
		const row = store.database
			.prepare("SELECT msg, msgid FROM messages WHERE msgid = 'new-msgid'")
			.get() as {msg: string; msgid: string};
		expect(JSON.parse(row.msg)).to.not.have.property("msgid");

		const found = await store.search({
			searchTerm: "with an id",
			networkUuid: net.uuid,
			channelName: chan.name,
			offset: 0,
		});
		expect(found.results.map((m) => m.msgid)).to.deep.equal(["new-msgid"]);
	}

	it("should create new databases with the column", async function () {
		const store = await open();

		expect(columns(store)).to.include("msgid");
		expect(hasIndex(store)).to.equal(true);
		await roundTrip(store);
	});

	it("should add the column to a database this fork upgraded before it", async function () {
		createOtherBuildDb(file, forkBeforeMsgid);
		const store = await open();

		expect(await store.current_version()).to.equal(currentSchemaVersion);
		expect(columns(store)).to.include("msgid");
		expect(hasIndex(store)).to.equal(true);

		// The existing history is still there, without ids
		const old = await store.getMessages(net, chan, () => undefined);
		expect(old).to.have.lengthOf(20);
		expect(old[0].text).to.equal("old message 0");
		expect(old[0].msgid).to.equal(undefined);

		await roundTrip(store);
	});

	it("should take over a stock 4.6 database that already has it", async function () {
		createOtherBuildDb(file, otherBuilds[2]);
		const store = await open();

		expect(await store.current_version()).to.equal(currentSchemaVersion);
		expect(columns(store).filter((c) => c === "msgid")).to.have.lengthOf(1);
		expect(hasIndex(store)).to.equal(true);

		// Its ids are kept
		const old = await store.getMessages(net, chan, () => undefined);
		expect(old.map((m) => m.msgid)).to.deep.equal(
			Array.from({length: 20}, (_, i) => `old-msgid-${i}`)
		);

		// Stock's own record of the migration is kept
		expect(
			store.database
				.prepare("SELECT count(*) FROM migrations WHERE version = 1784073600000")
				.pluck()
				.get()
		).to.equal(1);

		await roundTrip(store);

		// Rolling back to stock 4.6 keeps the column, which it needs. The
		// search index goes, so let its background build finish first.
		await store.finishSearchIndex();
		await store.downgrade_to(1784073600000);
		expect(columns(store)).to.include("msgid");
		expect(hasIndex(store)).to.equal(true);
		expect(
			store.database
				.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'messages_fts'")
				.pluck()
				.get()
		).to.equal(0);

		// Going further back, past it, drops the column once, without failing
		await store.downgrade_to(1780272000000);
		expect(columns(store)).to.not.include("msgid");
		expect(hasIndex(store)).to.equal(false);
	});

	it("should keep the column when a stock 4.5 database is rolled back to stock 4.6", async function () {
		createOtherBuildDb(file, otherBuilds[1]);
		const store = await open();

		expect(columns(store)).to.include("msgid");
		await store.finishSearchIndex();

		await store.downgrade_to(1784073600000);
		expect(columns(store)).to.include("msgid");
		expect(hasIndex(store)).to.equal(true);
		expect(await store.getMessages(net, chan, () => undefined)).to.have.lengthOf(20);

		await store.downgrade_to(1780272000000);
		expect(columns(store)).to.not.include("msgid");
		expect(hasIndex(store)).to.equal(false);
	});

	it("should remove the column when rolled back, and add it again", async function () {
		const store = await open();
		await roundTrip(store);

		const previous = migrations[migrations.length - 2].version;
		await store.downgrade_to(previous);

		expect(columns(store)).to.not.include("msgid");
		expect(hasIndex(store)).to.equal(false);
		// The migrations before it are untouched
		expect(
			store.database
				.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'messages_fts'")
				.pluck()
				.get()
		).to.equal(1);

		store.database
			.prepare("UPDATE options SET value = ? WHERE name = 'schema_version'")
			.run(previous.toString());
		await store.run_migrations();

		expect(await store.current_version()).to.equal(currentSchemaVersion);
		expect(columns(store)).to.include("msgid");
		expect(hasIndex(store)).to.equal(true);
	});
});

describe("SQLite background search index", function () {
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
		await store.deleteChannel({uuid: "net"} as Network, {name: "#first"} as Channel);
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
});

describe("SQLite clearing history", function () {
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

	beforeAll(function () {
		store = new MessageStorage("testUser");

		// Delete database file from previous test run
		if (fs.existsSync(expectedPath)) {
			fs.unlinkSync(expectedPath);
		}
	});

	afterAll(function () {
		// After tests run, remove the logs folder
		// so we return to the clean state
		fs.unlinkSync(expectedPath);
		fs.rmdirSync(path.join(Config.getHomePath(), "logs"));
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
		// Take the index away the way an older build rolling back would. That
		// also takes away the migrations after it, which run again below.
		const ftsAt = migrations.findIndex((m) => m.version === 1794820000000);
		const previous = migrations[ftsAt - 1].version;
		await store.downgrade_to(previous);
		expect(await store.current_version()).to.equal(previous);

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
		expect(await store.current_version()).to.equal(currentSchemaVersion);
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
