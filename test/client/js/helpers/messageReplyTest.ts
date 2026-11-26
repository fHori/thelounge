import {expect} from "chai";
import eventbus from "../../../../client/js/eventbus.js";
import {
	canReplyToMessage,
	generateMessageContextMenu,
	replyText,
} from "../../../../client/js/helpers/messageReply.js";

describe("messageReply", function () {
	const msg = {from: {nick: "alice"}, text: "hello"};

	it("offers Reply for a message with a sender and text", function () {
		const items = generateMessageContextMenu({}, msg);

		expect(items).to.have.length(1);
		expect(items[0]).to.include({label: "Reply", type: "item", class: "reply"});
	});

	it("offers nothing when replying is off or impossible", function () {
		expect(generateMessageContextMenu({enableReplyToMessage: false}, msg)).to.have.length(0);
		expect(generateMessageContextMenu({}, {text: "hello"})).to.have.length(0);
		expect(generateMessageContextMenu({}, {from: {nick: "alice"}, text: ""})).to.have.length(0);
	});

	it("checks text on the original message", function () {
		const shown = {from: {nick: "bob"}, text: "bridged"};

		expect(canReplyToMessage({}, shown, {text: ""})).to.equal(false);
		expect(canReplyToMessage({}, shown, {text: "<bob> bridged"})).to.equal(true);
	});

	it("emits the same reply text as the hover button", function () {
		const seen: unknown[] = [];
		const handler = (text: unknown) => seen.push(text);
		eventbus.on("message:reply", handler);

		try {
			const item = generateMessageContextMenu({replyToMessagePlainText: true}, msg)[0];
			(item as {action: () => void}).action();
		} finally {
			eventbus.off("message:reply", handler);
		}

		expect(seen).to.deep.equal(['alice: (re: "hello") ']);
		expect(replyText({}, msg)).to.equal('\x02alice\x02: \x0314,99"\x1Dhello\x1D"\x03 ');
	});
});
