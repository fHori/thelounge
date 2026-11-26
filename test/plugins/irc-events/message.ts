import {EventEmitter} from "events";
import {expect} from "chai";
import type Client from "../../../server/client.js";
import Chan from "../../../server/models/chan.js";
import Network from "../../../server/models/network.js";
import message from "../../../server/plugins/irc-events/message.js";
import {compileHighlightRegex} from "../../../server/highlights.js";
import {ChanState, ChanType} from "../../../shared/types/chan.js";
import {READ_MARKER_CAP} from "../../../server/plugins/readMarker.js";

type Pushed = {title: string; body: string};

type HighlightLists = {
	global?: string;
	globalExceptions?: string;
	network?: string;
	networkExceptions?: string;
	ignoreGlobal?: boolean;
};

function setup(notifyAllMessages?: boolean, highlights: HighlightLists = {}) {
	const irc = Object.assign(new EventEmitter(), {user: {nick: "me"}});
	const chan = new Chan({name: "#test", state: ChanState.JOINED});
	const network = new Network({host: "example.com", channels: [chan]});
	network.highlightRegex = /\bme\b/i;
	network.customHighlightRegex = compileHighlightRegex(highlights.network);
	network.customHighlightExceptionRegex = compileHighlightRegex(highlights.networkExceptions);
	network.ignoreGlobalHighlights = !!highlights.ignoreGlobal;

	const pushed: Pushed[] = [];
	const client = {
		idMsg: 1,
		attachedClients: {},
		messageStorage: [],
		mentions: [],
		config: {clientSettings: {notifyAllMessages}},
		highlightRegex: compileHighlightRegex(highlights.global),
		highlightExceptionRegex: compileHighlightRegex(highlights.globalExceptions),
		manager: {
			webPush: {
				push(_client: unknown, payload: Pushed) {
					pushed.push(payload);
				},
			},
		},
		saved: 0,
		createChannel: (attr: Partial<Chan>) => new Chan(attr),
		save() {
			client.saved++;
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

	return {irc, chan, network, client, pushed, say};
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

	it("leaves out mentions already read on another client", function () {
		const {chan, pushed, say} = setup();
		const now = Date.now();
		chan.readMarker = now - 1000;

		// Played back by the bouncer, read on the phone meanwhile
		say("hello me", {time: now - 60 * 1000});
		expect(pushed).to.have.lengthOf(0);

		say("hello me again", {time: now});
		expect(pushed.map((p) => p.body)).to.deep.equal(["bob: hello me again"]);
	});
});

describe("message event read marker", function () {
	it("asks for the marker of a conversation that starts mid-session", function () {
		const {irc, network, client} = setup();
		const raw: string[][] = [];
		Object.assign(irc, {
			network: {cap: {isEnabled: (name: string) => name === READ_MARKER_CAP}},
			raw: (...args: string[]) => raw.push(args),
		});
		network.irc = irc as unknown as Network["irc"];

		irc.emit("privmsg", {nick: "carol", target: "me", message: "while you were away"});

		expect(network.getChannel("carol")?.type).to.equal(ChanType.QUERY);
		expect(raw).to.deep.include(["MARKREAD", "carol"]);
		expect(client.saved).to.equal(1);
	});
});

describe("message event custom highlights", function () {
	// Only highlights get pushed by default, so the pushes show what was highlighted
	const highlighted = (highlights: HighlightLists, lines: string[]) => {
		const {pushed, say} = setup(false, highlights);

		lines.forEach((line) => say(line));

		// Pushes after the first say "… and N other messages" on later lines
		return pushed.map((p) => p.body.split("\n")[0].replace(/^bob: /, ""));
	};

	it("highlights words from the network's own list", function () {
		expect(
			highlighted({network: "deploy, oncall"}, ["the deploy is done", "lunch?"])
		).to.deep.equal(["the deploy is done"]);
	});

	it("uses the global list and the network list together", function () {
		expect(
			highlighted({global: "release", network: "deploy"}, [
				"release time",
				"deploy time",
				"nap time",
			])
		).to.deep.equal(["release time", "deploy time"]);
	});

	it("lets the network's exceptions cancel a global highlight", function () {
		expect(
			highlighted({global: "release", networkExceptions: "release notes"}, [
				"release time",
				"see the release notes",
			])
		).to.deep.equal(["release time"]);
	});

	it("lets the network's exceptions cancel a nick highlight", function () {
		expect(highlighted({networkExceptions: "bot"}, ["hello me", "bot: ping me"])).to.deep.equal(
			["hello me"]
		);
	});

	it("skips global highlights on a network that opts out", function () {
		expect(
			highlighted({global: "release", network: "deploy", ignoreGlobal: true}, [
				"release time",
				"deploy time",
				"hello me",
			])
		).to.deep.equal(["deploy time", "hello me"]);
	});

	it("keeps global exceptions on a network that opts out of global highlights", function () {
		expect(
			highlighted({globalExceptions: "bot", ignoreGlobal: true}, ["hello me", "bot: ping me"])
		).to.deep.equal(["hello me"]);
	});

	it("still applies global exceptions to the network's highlights", function () {
		expect(
			highlighted({network: "deploy", globalExceptions: "dry run"}, [
				"deploy now",
				"deploy dry run",
			])
		).to.deep.equal(["deploy now"]);
	});
});
