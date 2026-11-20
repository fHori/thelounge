import {expect} from "chai";
import sinon from "sinon";

import Chan from "../../server/models/chan.js";
import Client from "../../server/client.js";
import Msg from "../../server/models/msg.js";
import Network from "../../server/models/network.js";
import Config from "../../server/config.js";
import MassEventAggregator, {
	maxCapturedPerSummary,
} from "../../server/plugins/massEventAggregator.js";
import {ChanType} from "../../shared/types/chan.js";
import {MessageType} from "../../shared/types/msg.js";

describe("Mass event aggregation", function () {
	let originalConfig: typeof Config.values.massEventDetection;
	let originalMaxHistory: number;
	let originalPublic: boolean;
	let clock: sinon.SinonFakeTimers;

	beforeAll(function () {
		originalConfig = Config.values.massEventDetection;
		originalMaxHistory = Config.values.maxHistory;
		originalPublic = Config.values.public;
		// History is only kept and stored in private mode
		Config.values.public = false;
	});

	afterAll(function () {
		Config.values.massEventDetection = originalConfig;
		Config.values.maxHistory = originalMaxHistory;
		Config.values.public = originalPublic;
	});

	beforeEach(function () {
		Config.values.massEventDetection = {
			enable: true,
			threshold: 3,
			windowMs: 10000,
			cooldownMs: 5000,
			maxDurationMs: 60000,
			refreshNamesAfter: true,
		};
		Config.values.maxHistory = 1000;
		clock = sinon.useFakeTimers({
			now: 1_000_000,
			toFake: ["setTimeout", "clearTimeout", "Date"],
		});
	});

	afterEach(function () {
		clock.restore();
	});

	function setup() {
		const chan = new Chan({name: "#flood", type: ChanType.CHANNEL});
		const stored: Msg[] = [];
		const emitted: {event: string; data: {msg: Msg}}[] = [];
		const raw = sinon.spy();
		const network = Object.create(Network.prototype) as Network;
		Object.assign(network, {uuid: "net", name: "net", channels: [chan], irc: {raw}});

		const client = Object.create(Client.prototype) as Client;
		Object.assign(client, {
			name: "tester",
			idMsg: 1,
			attachedClients: {},
			mentions: [],
			config: {clientSettings: {}},
			messageStorage: [
				{
					index(_network: unknown, _chan: unknown, msg: Msg) {
						stored.push(msg);
						return Promise.resolve();
					},
				},
			],
			emit: (event: string, data: {msg: Msg}) => emitted.push({event, data}),
			find: () => ({network, chan}),
			save: () => undefined,
		});
		client.massEventAggregator = new MassEventAggregator(client);

		// What the irc-events handlers do with a status message
		const receive = (msg: Msg) => {
			if (!client.massEventAggregator.processMessage(network, chan, msg)) {
				chan.pushMessage(client, msg);
			}
		};

		// `time` stands in for a server-time tag
		const join = (nick: string, time?: Date) => {
			clock.tick(100);
			const msg = new Msg({
				type: MessageType.JOIN,
				time: time || new Date(),
				from: {nick} as Msg["from"],
			});
			receive(msg);
			return msg;
		};

		const sentMessages = () => emitted.filter((e) => e.event === "msg").map((e) => e.data.msg);

		return {chan, network, client, stored, raw, join, receive, sentMessages};
	}

	it("delivers messages normally below the threshold", function () {
		const {chan, join, stored, sentMessages} = setup();

		join("a");
		join("b");
		clock.tick(60000);

		expect(sentMessages().map((m) => m.from.nick)).to.deep.equal(["a", "b"]);
		expect(chan.messages).to.have.lengthOf(2);
		expect(stored).to.have.lengthOf(2);
	});

	it("does not count messages already delivered before activation in the summary", function () {
		const {chan, join, sentMessages, raw} = setup();

		["a", "b", "c", "d", "e"].forEach((nick) => join(nick));

		// a and b went out before the threshold was reached; c, d and e are captured
		expect(sentMessages().map((m) => m.type)).to.deep.equal([
			MessageType.JOIN,
			MessageType.JOIN,
		]);

		clock.tick(5000);

		const sent = sentMessages();
		expect(sent).to.have.lengthOf(3);

		const summary = sent[2];
		expect(summary.type).to.equal(MessageType.MASS_EVENT);
		expect(summary.massEventSummary?.joins).to.equal(3);
		expect(chan.messages.map((m) => m.type)).to.deep.equal([
			MessageType.JOIN,
			MessageType.JOIN,
			MessageType.MASS_EVENT,
		]);
		expect(raw.calledOnceWith("NAMES", "#flood")).to.equal(true);
	});

	it("writes captured messages to storage, but not the summary", function () {
		const {chan, join, stored, client} = setup();

		const msgs = ["a", "b", "c", "d", "e"].map((nick) => join(nick));
		clock.tick(5000);

		// every individual message is stored, with its own id
		expect(stored).to.deep.equal(msgs);
		expect(new Set(stored.map((m) => m.id)).size).to.equal(5);
		expect(client.idMsg).to.equal(7); // 5 joins and the summary

		const summary = chan.messages[chan.messages.length - 1];
		expect(summary.type).to.equal(MessageType.MASS_EVENT);
		expect(summary.isLoggable()).to.equal(false);
		expect(stored).to.not.include(summary);

		// the summary covers exactly the time range of the captured messages
		expect(summary.massEventSummary?.startTime.getTime()).to.equal(msgs[2].time.getTime());
		expect(summary.massEventSummary?.endTime.getTime()).to.equal(msgs[4].time.getTime());
	});

	it("does not add stored rows a held summary stands for to memory", async function () {
		const {chan, join, stored, client, network} = setup();

		const older = new Msg({type: MessageType.MESSAGE, time: new Date(5000), text: "older"});
		older.id = 1000;

		["a", "b", "c", "d", "e"].forEach((nick) => join(nick));
		clock.tick(5000);

		const provider = {
			isEnabled: true,
			canProvideMessages: () => true,
			getMessages: () => Promise.resolve([older, ...stored]),
			getMessagesBefore: (_u: string, _n: string, before: number) =>
				Promise.resolve([older, ...stored].filter((m) => m.time.getTime() <= before)),
		};
		Object.assign(client, {messageProvider: provider});
		Object.assign(network.irc!, {network: {cap: {isEnabled: () => false}}});

		chan.loadMessages(client, network, true);
		await new Promise((resolve) => setImmediate(resolve));

		expect(chan.messages.map((m) => m.text || m.type)).to.deep.equal([
			"older",
			MessageType.JOIN,
			MessageType.JOIN,
			MessageType.MASS_EVENT,
		]);
	});

	it("covers stored rows of the mass event that is still in progress", function () {
		const {chan, join, client} = setup();

		const msgs = ["a", "b", "c", "d"].map((nick) => join(nick));
		const covered = client.massEventAggregator.coveredByMassEvent(chan);

		expect(msgs.map(covered)).to.deep.equal([false, false, true, true]);

		const text = new Msg({type: MessageType.MESSAGE, time: msgs[3].time, text: "hi"});
		expect(covered(text)).to.equal(false);

		// stored later, after the summary was taken: newer than anything captured
		const later = new Msg({type: MessageType.JOIN, time: new Date(Date.now() + 1000)});
		later.id = 9999;
		expect(covered(later)).to.equal(false);
	});

	it("covers only the captured messages, whatever their timestamps say", function () {
		const {chan, join, client} = setup();

		// a replayed join (bouncer playback) with an old timestamp is captured
		["a", "b"].forEach((nick) => join(nick));
		const replayed = join("c", new Date(10_000));
		const captured = ["d", "e"].map((nick) => join(nick));
		clock.tick(5000);

		const summary = chan.messages[chan.messages.length - 1];
		expect(summary.type).to.equal(MessageType.MASS_EVENT);

		// a join that was delivered normally, from within the time range the
		// summary's messages span
		const delivered = new Msg({type: MessageType.JOIN, time: new Date(500_000)});
		delivered.id = 1234;

		const covered = client.massEventAggregator.coveredByMassEvent(chan);
		expect([replayed, ...captured].map(covered)).to.deep.equal([true, true, true]);
		expect(covered(delivered)).to.equal(false);

		// the same id from a different time is a different message
		expect(covered({...replayed, time: new Date(10_001)} as Msg)).to.equal(false);

		// once the summary leaves memory, its messages are no longer covered
		chan.messages = chan.messages.filter((m) => m !== summary);
		expect(client.massEventAggregator.coveredByMassEvent(chan)(replayed)).to.equal(false);
	});

	it("splits a flood into summaries of a bounded size", function () {
		const {chan, join, client} = setup();
		Config.values.massEventDetection.maxDurationMs = 24 * 3600 * 1000;

		const total = maxCapturedPerSummary + 10;

		for (let i = 0; i < total + 2; i++) {
			join(`n${i}`);
		}

		// the first summary is out, the rest is still being captured
		const summaries = chan.messages.filter((m) => m.type === MessageType.MASS_EVENT);
		expect(summaries).to.have.lengthOf(1);
		expect(summaries[0].massEventSummary?.joins).to.equal(maxCapturedPerSummary);
		expect(client.massEventAggregator.isActive(chan.id)).to.equal(true);

		clock.tick(5000);
		const done = chan.messages.filter((m) => m.type === MessageType.MASS_EVENT);
		expect(done).to.have.lengthOf(2);
		expect(done[1].massEventSummary?.joins).to.equal(10);
	});

	it("stops the timers when the channel is parted", function () {
		const {chan, network, client, join, sentMessages} = setup();

		["a", "b", "c", "d"].forEach((nick) => join(nick));
		expect(client.massEventAggregator.isActive(chan.id)).to.equal(true);
		expect(clock.countTimers()).to.equal(2);

		client.part(network, chan);

		expect(clock.countTimers()).to.equal(0);
		expect(client.massEventAggregator.isActive(chan.id)).to.equal(false);

		clock.tick(60000);
		expect(sentMessages().filter((m) => m.type === MessageType.MASS_EVENT)).to.have.lengthOf(0);
	});

	it("stops the timers when the network is removed", function () {
		const {chan, network, client, join} = setup();

		["a", "b", "c", "d"].forEach((nick) => join(nick));
		expect(clock.countTimers()).to.equal(2);

		network.destroy(client);

		expect(clock.countTimers()).to.equal(0);
		expect(client.massEventAggregator.isActive(chan.id)).to.equal(false);
	});
});
