import fs from "fs";
import path from "path";
import {expect} from "chai";
import Database from "better-sqlite3";
import util from "../util.js";
import Msg from "../../server/models/msg.js";
import {MessageType} from "../../shared/types/msg.js";
import Config from "../../server/config.js";
import ThreadedSqliteMessageStorage, {
	diagnosticsTimeout,
	searchBatchRows,
	stopStorageThread,
} from "../../server/plugins/messageStorage/sqliteThread.js";
import type Network from "../../server/models/network.js";
import type {Channel} from "../../server/models/chan.js";
import type {SearchCursor} from "../../shared/types/storage.js";

const net = {uuid: "thread-net"} as Network;
const chan = {name: "#Thread"} as Channel;

function message(id: number, time: number, text: string) {
	return new Msg({
		id,
		type: MessageType.MESSAGE,
		time: new Date(time),
		text,
		from: {mode: "", nick: "someone"},
	});
}

describe("SQLite message storage thread", function () {
	this.timeout(util.isRunningOnCI() ? 25000 : 10000);
	this.slow(1000);

	const dbPath = path.join(Config.getHomePath(), "logs", "threadUser.sqlite3");
	let store: ThreadedSqliteMessageStorage;

	function removeDatabase() {
		for (const suffix of ["", "-wal", "-shm"]) {
			fs.rmSync(dbPath + suffix, {force: true});
		}
	}

	before(async function () {
		removeDatabase();
		store = new ThreadedSqliteMessageStorage("threadUser");
		await store.enable();
	});

	after(async function () {
		await store.close();
		await stopStorageThread();
		removeDatabase();
	});

	it("opens the database on the storage thread", function () {
		expect(store.isEnabled).to.equal(true);
		expect(store.canProvideMessages()).to.equal(true);
		expect(fs.existsSync(dbPath)).to.equal(true);
	});

	it("stores messages and reads them back as messages", async function () {
		for (let i = 1; i <= 5; i++) {
			await store.index(net, chan, message(100 + i, 1000 * i, `hello number ${i}`));
		}

		let reported = 0;
		const messages = await store.getMessages(net, chan, (maxId) => (reported = maxId));

		expect(messages.map((m) => m.text)).to.deep.equal([
			"hello number 1",
			"hello number 2",
			"hello number 3",
			"hello number 4",
			"hello number 5",
		]);
		expect(messages[0]).to.be.instanceOf(Msg);
		expect(messages[0].time).to.be.instanceOf(Date);
		expect(messages[0].time.getTime()).to.equal(1000);
		expect(messages.map((m) => m.id)).to.deep.equal([101, 102, 103, 104, 105]);
		expect(reported).to.equal(105);
		expect(await store.getMaxMessageId()).to.equal(105);
	});

	it("pages and searches through the storage thread", async function () {
		const before = await store.getMessagesBefore(net.uuid, chan.name, 3000, 10);
		expect(before.map((m) => m.id)).to.deep.equal([101, 102]);
		expect(before[0]).to.be.instanceOf(Msg);

		const after = await store.getMessagesAfter(net.uuid, chan.name, 4000, 10);
		expect(after.map((m) => m.id)).to.deep.equal([104, 105]);

		const around = await store.getMessagesAround(net.uuid, chan.name, 3000, 2);
		expect(around.messages.map((m) => m.id)).to.deep.equal([103, 104]);
		expect(around.hasMoreBefore).to.equal(true);
		expect(around.hasMoreAfter).to.equal(true);

		const found = await store.search({
			networkUuid: net.uuid,
			channelName: chan.name,
			searchTerm: "number 4",
			offset: 0,
		});
		expect(found.results.map((m) => m.text)).to.deep.equal(["hello number 4"]);
		expect(found.results[0]).to.be.instanceOf(Msg);
	});

	it("keeps the shape of searches, never the term, for diagnostics", async function () {
		await store.search({
			networkUuid: net.uuid,
			channelName: "",
			searchTerm: "secret from:someone",
			offset: 0,
		});

		const diagnostics = await store.diagnostics(true);
		const [last] = diagnostics.searches;

		expect(last).to.include({termLength: 6, scope: "network", strategy: "lookup"});
		expect(last.filters).to.deep.equal(["from"]);
		expect(last.totalMs).to.be.at.least(last.queryMs);
		expect(JSON.stringify(diagnostics)).to.not.include("secret");
		expect(JSON.stringify(diagnostics)).to.not.include("someone");
		expect(JSON.stringify(diagnostics)).to.not.include(dbPath);

		expect(diagnostics).to.include({storage: "sqlite", open: true});
		expect(diagnostics.index).to.deep.equal({state: "complete"});
		expect(diagnostics.database!.maxRowId).to.equal(5);
		expect(diagnostics.thread!.pingMs).to.be.at.least(0);
		expect(diagnostics.disk!.reads).to.equal(64);
	});

	it("passes storage errors back to the caller", async function () {
		let error: unknown;

		try {
			await store.getMessagesBefore(net.uuid, chan.name, 3000, "not a number" as never);
		} catch (err) {
			error = err;
		}

		expect(error).to.be.instanceOf(Error);
	});

	it("keeps the server's thread free while the database is busy", async function () {
		await store.index(net, chan, message(106, 6000, "written while locked"));

		// Another connection holds the write lock, so storing the queued
		// message has to wait for it. On the server's thread that wait would
		// stop everything, timers included.
		const blocker = new Database(dbPath);
		blocker.exec("BEGIN IMMEDIATE");

		let ticks = 0;
		const ticker = setInterval(() => ticks++, 10);
		const started = Date.now();
		const reading = store.getMessages(net, chan, () => 0);

		try {
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(ticks).to.be.greaterThan(10);
		} finally {
			blocker.exec("COMMIT");
			blocker.close();
			clearInterval(ticker);
		}

		const messages = await reading;
		expect(Date.now() - started).to.be.at.least(300);
		expect(messages.at(-1)?.text).to.equal("written while locked");
	});

	it("says the storage thread is busy rather than waiting for it", async function () {
		await store.index(net, chan, message(107, 7000, "stored while busy"));

		// Storing the queued message waits for the lock, so the thread
		// answers nothing else meanwhile
		const blocker = new Database(dbPath);
		blocker.exec("BEGIN IMMEDIATE");
		const reading = store.getMessages(net, chan, () => 0);
		const timeout = diagnosticsTimeout.ms;
		diagnosticsTimeout.ms = 100;

		try {
			const diagnostics = await store.diagnostics();
			expect(diagnostics.thread).to.deep.equal({pingMs: null, waiting: 1});
			expect(diagnostics.database).to.equal(undefined);
		} finally {
			diagnosticsTimeout.ms = timeout;
			blocker.exec("COMMIT");
			blocker.close();
		}

		await reading;
		const after = await store.diagnostics();
		expect(after.thread!.pingMs).to.be.a("number");
		expect(after.thread!.stores).to.be.at.least(1);
		expect(after.thread!.buildingIndex).to.equal(0);
	});

	// In order with the tests around them, on the same open store
	const streamChan = {name: "#stream"} as Channel;
	const streamRequest = (cursor: SearchCursor | null = null, searchTerm = "stream line") => ({
		searchTerm,
		networkUuid: net.uuid,
		channelName: streamChan.name,
		cursor,
	});

	it("streams search results a batch at a time, a page at a time", async function () {
		for (let i = 0; i < 250; i++) {
			await store.index(net, streamChan, message(1000 + i, 100000 + i, `stream line ${i}`));
		}

		const seen = new Set<string>();
		const batches: Msg[][] = [];
		let cursor: SearchCursor | null = null;
		let pages = 0;

		do {
			cursor = await store.searchStream(streamRequest(cursor), (results) => {
				batches.push(results);

				for (const m of results) {
					expect(seen.has(m.text), `${m.text} twice`).to.equal(false);
					seen.add(m.text);
				}
			});
			pages++;
		} while (cursor);

		expect(seen.size).to.equal(250);
		expect(pages).to.equal(3);
		expect(batches[0][0]).to.be.instanceOf(Msg);
		// The first batch is small, so the first results show at once
		expect(batches[0].length).to.be.at.most(searchBatchRows.lookup.start);
		expect(batches[0].map((m) => m.text)).to.include("stream line 249");

		const [last] = (await store.diagnostics()).searches;
		expect(last).to.include({more: true, cancelled: false});
		expect(last.batches).to.be.at.least(1);
		expect(last.firstMs).to.be.a("number");
	});

	it("stops a search that is cancelled", async function () {
		let batches = 0;
		const cursor = await store.searchStream(
			streamRequest(),
			() => batches++,
			() => true
		);

		expect(batches).to.equal(1);
		expect(cursor).to.not.equal(null);

		const [last] = (await store.diagnostics()).searches;
		expect(last).to.include({cancelled: true, batches: 1, more: false});
	});

	it("streams a scan the same way while the index can't help", async function () {
		const found: string[] = [];
		let cursor: SearchCursor | null = null;

		do {
			cursor = await store.searchStream(streamRequest(cursor, "st"), (results) =>
				found.push(...results.map((m) => m.text))
			);
		} while (cursor);

		expect(found.filter((t) => t.startsWith("stream line"))).to.have.lengthOf(250);
		const [last] = (await store.diagnostics()).searches;
		expect(last).to.include({strategy: "scan", reason: "short-term"});
	});

	it("hides a cleared channel", async function () {
		await store.deleteChannel(net, chan);
		expect(await store.getMessages(net, chan, () => 0)).to.have.lengthOf(0);
	});

	it("stores and shows nothing once closed", async function () {
		await store.close();
		expect(store.isEnabled).to.equal(false);

		await store.index(net, chan, message(200, 9000, "after close"));
		expect(await store.getMessages(net, chan, () => 0)).to.deep.equal([]);
		expect(await store.getMaxMessageId()).to.equal(0);
	});

	// As when the server stops right after a user was added
	it("finishes opening a database that is closed and shut down meanwhile", async function () {
		const late = new ThreadedSqliteMessageStorage("threadUser");
		const opening = late.enable();
		const closing = late.close();
		await stopStorageThread();

		await opening;
		await closing;
		expect(late.isEnabled).to.equal(false);

		// Closed for real: nothing else holds the database
		const db = new Database(dbPath);
		db.pragma("journal_mode = DELETE");
		db.close();
	});
});
