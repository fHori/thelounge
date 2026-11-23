import fs from "fs";
import path from "path";
import {expect} from "chai";
import Database from "better-sqlite3";
import util from "../util.js";
import Msg from "../../server/models/msg.js";
import {MessageType} from "../../shared/types/msg.js";
import Config from "../../server/config.js";
import ThreadedSqliteMessageStorage, {
	stopStorageThread,
} from "../../server/plugins/messageStorage/sqliteThread.js";
import type Network from "../../server/models/network.js";
import type {Channel} from "../../server/models/chan.js";

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
});
