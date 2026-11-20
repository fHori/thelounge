import {EventEmitter} from "events";
import {expect} from "chai";
import type Client from "../../../server/client.js";
import Chan from "../../../server/models/chan.js";
import Network from "../../../server/models/network.js";
import message from "../../../server/plugins/irc-events/message.js";
import {ChanState} from "../../../shared/types/chan.js";

type Pushed = {title: string; body: string};

function setup(notifyAllMessages?: boolean) {
	const irc = Object.assign(new EventEmitter(), {user: {nick: "me"}});
	const chan = new Chan({name: "#test", state: ChanState.JOINED});
	const network = new Network({host: "example.com", channels: [chan]});
	network.highlightRegex = /\bme\b/i;

	const pushed: Pushed[] = [];
	const client = {
		idMsg: 1,
		attachedClients: {},
		messageStorage: [],
		mentions: [],
		config: {clientSettings: {notifyAllMessages}},
		manager: {
			webPush: {
				push(_client: unknown, payload: Pushed) {
					pushed.push(payload);
				},
			},
		},
		emit() {},
	};

	message.call(
		client as unknown as Client,
		irc as unknown as Parameters<typeof message>[0],
		network as Parameters<typeof message>[1]
	);

	const say = (text: string, extra: Record<string, unknown> = {}) =>
		irc.emit("privmsg", {nick: "bob", target: "#test", message: text, ...extra});

	return {irc, chan, pushed, say};
}

describe("message event web push", function () {
	it("pushes highlights only by default", function () {
		const {pushed, say} = setup();

		say("hello everyone");
		say("hello me");

		expect(pushed.map((p) => p.body)).to.deep.equal(["bob: hello me"]);
	});

	it("pushes every message when notify for all messages is on", function () {
		const {pushed, say} = setup(true);

		say("hello everyone");

		expect(pushed).to.have.lengthOf(1);
		expect(pushed[0]).to.include({title: "#test", body: "bob: hello everyone"});
	});

	it("still leaves out own, muted, old and non-message lines", function () {
		const {irc, chan, pushed, say} = setup(true);

		say("my own line", {nick: "me"});
		say("from the bouncer buffer", {time: Date.now() - 60 * 60 * 1000});
		irc.emit("notice", {nick: "bob", target: "#test", message: "a notice"});
		chan.muted = true;
		say("in a muted channel");

		expect(pushed).to.have.lengthOf(0);
	});
});
