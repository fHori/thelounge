import {EventEmitter} from "events";
import {expect} from "chai";
import sinon from "sinon";
import Client from "../../../server/client.js";
import Config from "../../../server/config.js";
import Chan from "../../../server/models/chan.js";
import Msg from "../../../server/models/msg.js";
import Network from "../../../server/models/network.js";
import markread from "../../../server/plugins/irc-events/markread.js";
import {
	READ_MARKER_CAP,
	requestReadMarker,
	scheduleReadMarker,
	sendReadMarker,
	setBrowserVisible,
} from "../../../server/plugins/readMarker.js";
import {ChanType} from "../../../shared/types/chan.js";
import {MessageType} from "../../../shared/types/msg.js";

type Emitted = {event: string; data: any};

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds));
const stamp = (seconds: number) => `timestamp=${at(seconds).toISOString()}`;

function setup({cap = true} = {}) {
	const raw: string[][] = [];
	const irc = Object.assign(new EventEmitter(), {
		network: {cap: {isEnabled: (name: string) => cap && name === READ_MARKER_CAP}},
		raw: (...args: string[]) => raw.push(args),
	});
	const chan = new Chan({id: 2, name: "#test"});
	const query = new Chan({id: 3, name: "bob", type: ChanType.QUERY});
	const network = new Network({host: "example.com", channels: [chan, query]});
	network.irc = irc as any;

	const emitted: Emitted[] = [];
	const client = {
		idMsg: 1,
		messageStorage: [],
		networks: [network],
		lastActiveChannel: -1,
		attachedClients: {} as Record<string, {openChannel: number; visible?: boolean}>,
		find(id: number) {
			const found = network.channels.find((c) => c.id === id);
			return found ? {network, chan: found} : false;
		},
		emit(event: string, data: any) {
			emitted.push({event, data});
		},
	};

	markread.apply(client as any, [irc as any, network as any]);

	// One unread message per second, starting at 12:00:01
	const receive = (target: Chan, seconds: number, attr: Partial<Msg> = {}) =>
		target.pushMessage(
			client as unknown as Client,
			new Msg({type: MessageType.MESSAGE, time: at(seconds), text: "hi", ...attr}),
			true
		);

	const markRead = (target: string, param: string) =>
		irc.emit("unknown command", {command: "MARKREAD", params: [target, param]});

	const unreadEvents = () => emitted.filter((e) => e.event === "channel:unread");

	return {irc, raw, chan, query, network, client, receive, markRead, unreadEvents};
}

describe("draft/read-marker", function () {
	let wasPublic: boolean;

	// Messages are only kept in memory outside of public mode
	before(function () {
		wasPublic = Config.values.public;
		Config.values.public = false;
	});

	after(function () {
		Config.values.public = wasPublic;
	});

	describe("marker from the server", function () {
		it("clears the unread state when everything was read elsewhere", function () {
			const {chan, receive, markRead, unreadEvents} = setup();

			receive(chan, 1);
			receive(chan, 2, {highlight: true});
			expect(chan.unread).to.equal(2);
			expect(chan.highlight).to.equal(1);

			markRead("#test", stamp(2));

			expect(chan.unread).to.equal(0);
			expect(chan.highlight).to.equal(0);
			expect(chan.firstUnread).to.equal(chan.messages[1].id);
			expect(unreadEvents()).to.deep.equal([
				{
					event: "channel:unread",
					data: {chan: 2, unread: 0, highlight: 0, firstUnread: chan.messages[1].id},
				},
			]);
		});

		it("keeps what is newer than the marker unread", function () {
			const {chan, receive, markRead} = setup();

			receive(chan, 1, {highlight: true});
			receive(chan, 2);
			receive(chan, 3, {highlight: true});

			markRead("#test", stamp(1));

			expect(chan.unread).to.equal(2);
			expect(chan.highlight).to.equal(1);
			expect(chan.firstUnread).to.equal(chan.messages[0].id);
		});

		it("never moves backwards", function () {
			const {chan, receive, markRead, unreadEvents} = setup();

			receive(chan, 1);
			receive(chan, 2);
			markRead("#test", stamp(2));
			markRead("#test", stamp(1));

			expect(chan.readMarker).to.equal(at(2).getTime());
			expect(chan.unread).to.equal(0);
			expect(unreadEvents()).to.have.lengthOf(1);
		});

		it("does not raise a count", function () {
			const {chan, receive, markRead} = setup();

			receive(chan, 1);
			receive(chan, 2);
			chan.unread = 0;

			markRead("#test", stamp(1));

			expect(chan.unread).to.equal(0);
		});

		it("does not count history played back from before the marker", function () {
			const {chan, receive, markRead} = setup();

			markRead("#test", stamp(5));
			receive(chan, 4, {highlight: true});
			receive(chan, 6);

			expect(chan.unread).to.equal(1);
			expect(chan.highlight).to.equal(0);
		});

		it("applies to private conversations", function () {
			const {query, receive, markRead} = setup();

			receive(query, 1, {highlight: true});
			markRead("BOB", stamp(1));

			expect(query.unread).to.equal(0);
			expect(query.highlight).to.equal(0);
		});

		it("ignores an unset marker, a bad timestamp and an unknown target", function () {
			const {chan, receive, markRead, unreadEvents} = setup();

			receive(chan, 1);
			markRead("#test", "*");
			markRead("#test", "timestamp=yesterday");
			markRead("#test", "");
			markRead("#other", stamp(1));

			expect(chan.unread).to.equal(1);
			expect(chan.readMarker).to.equal(0);
			expect(unreadEvents()).to.have.lengthOf(0);
		});

		it("keeps counting what is not a plain message", function () {
			const {query, receive, markRead} = setup();

			receive(query, 1);
			receive(query, 2, {type: MessageType.CTCP});
			receive(query, 3, {type: MessageType.ERROR});

			markRead("bob", stamp(1));

			expect(query.unread).to.equal(2);
		});

		it("does not count again what was read here before", function () {
			const {chan, receive, markRead} = setup();

			receive(chan, 1);
			receive(chan, 2, {highlight: true});
			chan.unread = 0;
			chan.highlight = 0;
			receive(chan, 3);

			markRead("#test", stamp(1));

			expect(chan.unread).to.equal(1);
			expect(chan.highlight).to.equal(0);
		});

		it("keeps the counts of messages that were trimmed from memory", function () {
			const {chan, receive, markRead} = setup();

			receive(chan, 1);
			receive(chan, 2, {highlight: true});
			receive(chan, 3);
			chan.messages.splice(0, 2);

			markRead("#test", stamp(1));

			expect(chan.unread).to.equal(2);
			expect(chan.highlight).to.equal(1);
		});

		it("keeps the counts in public mode, where no message is in memory", function () {
			const {chan, receive, markRead} = setup();

			Config.values.public = true;

			try {
				receive(chan, 1);
				receive(chan, 2, {highlight: true});
				receive(chan, 3);
			} finally {
				Config.values.public = false;
			}

			expect(chan.messages).to.have.lengthOf(0);

			markRead("#test", stamp(1));
			expect(chan.unread).to.equal(2);
			expect(chan.highlight).to.equal(1);

			markRead("#test", stamp(3));
			expect(chan.unread).to.equal(0);
			expect(chan.highlight).to.equal(0);
		});

		it("leaves the counts alone when it cannot tell what was read", function () {
			const {chan, receive, markRead, unreadEvents} = setup();

			receive(chan, 5);
			receive(chan, 6, {highlight: true});
			chan.unread = 5;
			chan.highlight = 3;
			chan.messages = [];

			markRead("#test", stamp(4));
			expect(chan.unread).to.equal(5);
			expect(chan.highlight).to.equal(3);
			expect(unreadEvents()).to.have.lengthOf(0);

			markRead("#test", stamp(5));
			expect(chan.unread).to.equal(1);
			expect(chan.highlight).to.equal(1);
		});

		it("leaves a channel that is open in a browser alone", function () {
			const {chan, client, receive, markRead, unreadEvents} = setup();

			client.attachedClients.socket = {openChannel: chan.id};
			receive(chan, 1);
			markRead("#test", stamp(1));

			expect(chan.readMarker).to.equal(at(1).getTime());
			expect(unreadEvents()).to.have.lengthOf(0);
		});
	});

	describe("marker sent to the server", function () {
		it("marks the newest message read", function () {
			const {chan, network, raw, receive} = setup();

			receive(chan, 1);
			receive(chan, 2);
			sendReadMarker(network, chan);

			expect(raw).to.deep.equal([
				["MARKREAD", "#test", "timestamp=2026-01-01T12:00:02.000Z"],
			]);
		});

		it("sends nothing when the marker would not move", function () {
			const {chan, network, raw, receive, markRead} = setup();

			sendReadMarker(network, chan);
			receive(chan, 1);
			sendReadMarker(network, chan);
			sendReadMarker(network, chan);
			markRead("#test", stamp(1));
			sendReadMarker(network, chan);

			expect(raw).to.have.lengthOf(1);
		});

		it("skips messages made here with a time of their own", function () {
			const {chan, client, network, raw, receive} = setup();

			receive(chan, 1);
			chan.pushMessage(
				client as unknown as Client,
				new Msg({type: MessageType.MASS_EVENT, time: at(9), localTime: true})
			);
			sendReadMarker(network, chan);

			expect(raw).to.deep.equal([
				["MARKREAD", "#test", "timestamp=2026-01-01T12:00:01.000Z"],
			]);
		});

		it("only uses the time the server gave a message", function () {
			const {chan, client, network, raw, receive} = setup();

			receive(chan, 1);
			// Stamped with our own clock: made here, or received without server-time
			chan.pushMessage(client as unknown as Client, new Msg({text: "local"}), true);
			sendReadMarker(network, chan);

			expect(raw).to.deep.equal([
				["MARKREAD", "#test", "timestamp=2026-01-01T12:00:01.000Z"],
			]);
		});

		it("takes the time from lines people read only", function () {
			const {chan, client, network, raw, receive} = setup();

			receive(chan, 1);
			// Stored before lines made here were flagged: an error with no localTime
			chan.pushMessage(
				client as unknown as Client,
				new Msg({type: MessageType.ERROR, time: at(9), text: "Connection closed"})
			);
			sendReadMarker(network, chan);

			expect(raw).to.deep.equal([
				["MARKREAD", "#test", "timestamp=2026-01-01T12:00:01.000Z"],
			]);
		});

		it("sends nothing when no message has a time from the server", function () {
			const {chan, client, network, raw} = setup();

			chan.pushMessage(client as unknown as Client, new Msg({text: "local"}), true);
			chan.pushMessage(client as unknown as Client, new Msg({text: "local too"}), true);
			sendReadMarker(network, chan);

			expect(raw).to.have.lengthOf(0);
		});

		it("sends nothing without the capability, or for the lobby", function () {
			const without = setup({cap: false});
			without.receive(without.chan, 1);
			sendReadMarker(without.network, without.chan);
			expect(without.raw).to.have.lengthOf(0);

			const {network, raw, receive} = setup();
			const lobby = new Chan({name: "example.com", type: ChanType.LOBBY});
			receive(lobby, 1);
			sendReadMarker(network, lobby);
			expect(raw).to.have.lengthOf(0);
		});

		describe("for messages arriving in an open channel", function () {
			let clock: sinon.SinonFakeTimers;

			beforeEach(function () {
				clock = sinon.useFakeTimers();
			});

			afterEach(function () {
				clock.restore();
			});

			it("sends one marker for a burst of messages", function () {
				const {chan, client, network, raw, receive} = setup();

				client.attachedClients.socket = {openChannel: chan.id};

				for (let seconds = 1; seconds <= 3; seconds++) {
					receive(chan, seconds);
					scheduleReadMarker(client as unknown as Client, network, chan);
				}

				expect(raw).to.have.lengthOf(0);
				clock.tick(1000);
				expect(raw).to.deep.equal([
					["MARKREAD", "#test", "timestamp=2026-01-01T12:00:03.000Z"],
				]);
			});

			it("sends nothing while the tab is in the background", function () {
				const {chan, client, network, raw, receive} = setup();

				client.attachedClients.socket = {openChannel: chan.id};
				setBrowserVisible(client as unknown as Client, "socket", false);

				receive(chan, 1);
				scheduleReadMarker(client as unknown as Client, network, chan);
				clock.tick(1000);

				expect(raw).to.have.lengthOf(0);
			});

			it("sends when another tab has the channel on screen", function () {
				const {chan, client, network, raw, receive} = setup();

				client.attachedClients.hidden = {openChannel: chan.id, visible: false};
				client.attachedClients.shown = {openChannel: chan.id, visible: true};

				receive(chan, 1);
				scheduleReadMarker(client as unknown as Client, network, chan);
				clock.tick(1000);

				expect(raw).to.have.lengthOf(1);
			});

			it("sends nothing when the channel is not open", function () {
				const {chan, client, network, raw, receive} = setup();

				receive(chan, 1);
				scheduleReadMarker(client as unknown as Client, network, chan);
				clock.tick(1000);

				expect(raw).to.have.lengthOf(0);
			});

			it("sets no timer for a channel nobody is reading", function () {
				const {chan, client, network, receive} = setup();

				receive(chan, 1);
				scheduleReadMarker(client as unknown as Client, network, chan);
				expect(clock.countTimers()).to.equal(0);

				client.attachedClients.socket = {openChannel: chan.id, visible: false};
				scheduleReadMarker(client as unknown as Client, network, chan);
				expect(clock.countTimers()).to.equal(0);

				client.attachedClients.socket.visible = true;
				scheduleReadMarker(client as unknown as Client, network, chan);
				expect(clock.countTimers()).to.equal(1);
			});
		});
	});

	describe("tab visibility", function () {
		it("marks the open channel read when the tab comes back", function () {
			const {chan, client, raw, receive} = setup();
			const asClient = client as unknown as Client;

			client.attachedClients.socket = {openChannel: chan.id};
			setBrowserVisible(asClient, "socket", false);
			receive(chan, 1);
			receive(chan, 2);
			expect(raw).to.have.lengthOf(0);

			setBrowserVisible(asClient, "socket", true);

			expect(raw).to.deep.equal([
				["MARKREAD", "#test", "timestamp=2026-01-01T12:00:02.000Z"],
			]);
		});

		it("does nothing when the visibility did not change", function () {
			const {chan, client, raw, receive} = setup();
			const asClient = client as unknown as Client;

			client.attachedClients.socket = {openChannel: chan.id};
			receive(chan, 1);

			// A tab is taken to be on screen until it says otherwise
			setBrowserVisible(asClient, "socket", true);
			setBrowserVisible(asClient, "unknown", true);

			expect(raw).to.have.lengthOf(0);
		});

		it("does nothing when no channel is open", function () {
			const {client, raw} = setup();
			const asClient = client as unknown as Client;

			client.attachedClients.socket = {openChannel: -1, visible: false};
			setBrowserVisible(asClient, "socket", true);

			expect(raw).to.have.lengthOf(0);
		});
	});

	describe("browser reconnecting", function () {
		const reconnect = (client: unknown, chanId: number, visible?: boolean) => {
			Client.prototype.clientAttach.call(client, "socket", "token", visible);
			Client.prototype.open.call(client, "socket", chanId);
		};

		it("does not mark the open channel read from a background tab", function () {
			const {chan, client, raw, receive} = setup();

			receive(chan, 1);
			reconnect(client, chan.id, false);

			expect(client.attachedClients.socket.visible).to.equal(false);
			expect(raw).to.have.lengthOf(0);

			setBrowserVisible(client as unknown as Client, "socket", true);
			expect(raw).to.have.lengthOf(1);
		});

		it("marks the open channel read from a tab that is on screen", function () {
			const {chan, client, raw, receive} = setup();

			receive(chan, 1);
			reconnect(client, chan.id, true);

			expect(raw).to.deep.equal([
				["MARKREAD", "#test", "timestamp=2026-01-01T12:00:01.000Z"],
			]);
		});

		it("takes an older browser that does not say to be on screen", function () {
			const {chan, client, raw, receive} = setup();

			receive(chan, 1);
			reconnect(client, chan.id);

			expect(client.attachedClients.socket).to.not.have.property("visible");
			expect(raw).to.have.lengthOf(1);
		});
	});

	describe("on connect", function () {
		it("asks for the marker of private conversations", function () {
			const {irc, raw} = setup();

			irc.emit("registered");

			expect(raw).to.deep.equal([["MARKREAD", "bob"]]);
		});

		it("asks for the marker of a conversation, not of a channel", function () {
			const {chan, query, network, raw} = setup();

			requestReadMarker(network, query);
			requestReadMarker(network, chan);

			expect(raw).to.deep.equal([["MARKREAD", "bob"]]);
		});

		it("asks for nothing without the capability", function () {
			const {irc, raw} = setup({cap: false});

			irc.emit("registered");

			expect(raw).to.have.lengthOf(0);
		});
	});
});
