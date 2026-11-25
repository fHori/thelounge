import {expect} from "chai";

import Chan from "../../server/models/chan.js";
import User from "../../server/models/user.js";
import type Network from "../../server/models/network.js";
import UserIdentLookup from "../../server/plugins/userIdentLookup.js";

function setup(timeouts?: {answerMs: number; lateReplyMs: number}) {
	const sent: string[][] = [];
	const chan = new Chan({name: "#tracker"});
	const network = {
		uuid: "net",
		channels: [chan],
		irc: {connected: true, raw: (...args: string[]) => sent.push(args)},
	};

	return {
		lookup: new UserIdentLookup(timeouts),
		chan,
		sent,
		network: network as unknown as Network,
	};
}

describe("UserIdentLookup", function () {
	it("answers from what the server already said, without a WHOIS", async function () {
		const {lookup, chan, sent, network} = setup();
		chan.setUser(new User({nick: "Alice", ident: "66434", hostname: "alice.elite.example"}));

		expect(await lookup.lookup(network, "alice")).to.deep.equal({
			ident: "66434",
			hostname: "alice.elite.example",
		});
		expect(sent).to.deep.equal([]);
	});

	it("asks again when the known ident is not a user id", async function () {
		const {lookup, chan, sent, network} = setup();
		chan.setUser(new User({nick: "Mallory", ident: "~mallory", hostname: "m.example"}));

		const pending = lookup.lookup(network, "mallory");
		expect(sent).to.deep.equal([["WHOIS", "mallory"]]);

		lookup.handleWhois(network, {nick: "mallory", ident: "4321", hostname: "m.example"});
		expect(await pending).to.deep.equal({ident: "4321", hostname: "m.example"});
	});

	it("sends one WHOIS for a user it knows nothing about and hides the reply", async function () {
		const {lookup, chan, sent, network} = setup();
		chan.setUser(new User({nick: "Bob"}));

		const first = lookup.lookup(network, "Bob");
		const second = lookup.lookup(network, "bob");

		expect(sent).to.deep.equal([["WHOIS", "Bob"]]);

		const hidden = lookup.handleWhois(network, {
			nick: "bob",
			ident: "75412",
			hostname: "bob.elite.example",
		});

		expect(hidden).to.equal(true);
		expect(await first).to.deep.equal({ident: "75412", hostname: "bob.elite.example"});
		expect(await second).to.deep.equal(await first);

		// remembered, so the next lookup needs no WHOIS
		expect(await lookup.lookup(network, "BOB")).to.deep.equal(await first);
		expect(sent).to.have.lengthOf(1);
	});

	it("doesn't send a WHOIS for something that isn't a nick", async function () {
		const {lookup, sent, network} = setup();

		for (const nick of ["", "a b", "a,b", "a*", "#chan", "a\r\nQUIT", "x".repeat(65)]) {
			expect(await lookup.lookup(network, nick)).to.equal(null);
		}

		expect(sent).to.deep.equal([]);
	});

	it("waits for a few WHOIS replies per network at most", async function () {
		const {lookup, sent, network} = setup();

		for (let i = 0; i < 5; i++) {
			void lookup.lookup(network, `user${i}`);
		}

		expect(await lookup.lookup(network, "user5")).to.equal(null);
		expect(sent).to.have.lengthOf(5);

		// once one is answered there is room again
		lookup.handleWhois(network, {nick: "user0", ident: "1", hostname: "h"});
		void lookup.lookup(network, "user5");
		expect(sent).to.have.lengthOf(6);
		lookup.clear();
	});

	it("never takes a WHOWAS reply for the answer", async function () {
		const {lookup, network} = setup();
		const pending = lookup.lookup(network, "gina");

		expect(
			lookup.handleWhois(network, {nick: "gina", whowas: true, ident: "1", hostname: "h"})
		).to.equal(false);
		expect(lookup.handleWhois(network, {nick: "gina", ident: "2", hostname: "h"})).to.equal(
			true
		);
		expect(await pending).to.deep.equal({ident: "2", hostname: "h"});
	});

	it("leaves a WHOIS reply nobody is waiting for alone", function () {
		const {lookup, network} = setup();

		expect(lookup.handleWhois(network, {nick: "carol", ident: "1", hostname: "h"})).to.equal(
			false
		);
	});

	it("shows the reply when the user asked for the same WHOIS meanwhile", async function () {
		const {lookup, network} = setup();
		const pending = lookup.lookup(network, "dave");

		lookup.shownWhoisRequested(network, "Dave");
		expect(lookup.hideNoSuchNick(network, "dave")).to.equal(false);

		expect(lookup.handleWhois(network, {nick: "dave", ident: "7", hostname: "h"})).to.equal(
			false
		);
		expect(await pending).to.deep.equal({ident: "7", hostname: "h"});
	});

	it("answers with nothing for a nick that doesn't exist, and hides that too", async function () {
		const {lookup, network} = setup();
		const pending = lookup.lookup(network, "nobody");

		// the "No such nick" error that comes first is hidden as well, once
		expect(lookup.hideNoSuchNick(network, "NoBody")).to.equal(true);
		expect(lookup.hideNoSuchNick(network, "nobody")).to.equal(false);
		expect(lookup.hideNoSuchNick(network, "somebody")).to.equal(false);
		expect(lookup.handleWhois(network, {nick: "nobody", error: true})).to.equal(true);
		expect(lookup.hideNoSuchNick(network, "nobody")).to.equal(false);
		expect(await pending).to.equal(null);
	});

	it("keeps a reply that comes after giving up out of the client, once", async function () {
		const {lookup, chan, network} = setup({answerMs: 5, lateReplyMs: 1000});
		chan.setUser(new User({nick: "Hank"}));

		expect(await lookup.lookup(network, "hank")).to.equal(null);

		expect(lookup.hideNoSuchNick(network, "hank")).to.equal(true);
		expect(lookup.handleWhois(network, {nick: "Hank", ident: "88", hostname: "h"})).to.equal(
			true
		);
		// and still remembers what it said
		expect(chan.findUser("hank")!.ident).to.equal("88");
		expect(lookup.handleWhois(network, {nick: "hank", ident: "88", hostname: "h"})).to.equal(
			false
		);
		lookup.clear();
	});

	it("shows a late reply the user asked for, or one that comes much later", async function () {
		const {lookup, network} = setup({answerMs: 5, lateReplyMs: 20});

		expect(await lookup.lookup(network, "ivy")).to.equal(null);
		lookup.shownWhoisRequested(network, "Ivy");
		expect(lookup.handleWhois(network, {nick: "ivy", ident: "1", hostname: "h"})).to.equal(
			false
		);

		expect(await lookup.lookup(network, "jack")).to.equal(null);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(lookup.handleWhois(network, {nick: "jack", ident: "1", hostname: "h"})).to.equal(
			false
		);
	});

	it("answers with nothing when disconnected or when dropped", async function () {
		const {lookup, network} = setup();
		const pending = lookup.lookup(network, "erin");

		lookup.clear();
		expect(await pending).to.equal(null);
		// the late reply is an ordinary one again
		expect(lookup.handleWhois(network, {nick: "erin", ident: "1", hostname: "h"})).to.equal(
			false
		);

		network.irc!.connected = false;
		expect(await lookup.lookup(network, "frank")).to.equal(null);
	});
});

describe("profileFromWhois", function () {
	it("keeps the fields a profile shows, trimmed and typed", async function () {
		const {profileFromWhois} = await import("../../server/plugins/userIdentLookup.js");
		const profile = profileFromWhois({
			nick: "Iroha",
			ident: "~iroha",
			hostname: "host.example",
			real_name: "Iroha Example",
			account: "Iroha",
			channels: "@#general #dev",
			idle: "120",
			logon: 1763600000,
			secure: true,
			actual_ip: "203.0.113.7",
		});

		expect(profile).to.deep.include({
			nick: "Iroha",
			ident: "~iroha",
			realName: "Iroha Example",
			account: "Iroha",
			channels: "@#general #dev",
			idle: 120,
			logon: 1763600000,
			secure: true,
			operator: false,
		});
		expect(profile).not.to.have.property("actual_ip");
	});
});
