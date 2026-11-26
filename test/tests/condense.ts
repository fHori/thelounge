import {expect} from "chai";

import {condenseMessages, MessageCondenser} from "../../client/js/helpers/condense.js";
import type {ClientMessage} from "../../client/js/types.js";

// Deterministic pseudo-random numbers
function rng(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

let nextId = 1;

function message(random: () => number): ClientMessage {
	const r = random();
	const id = nextId++;
	// Mostly status messages, so groups get long
	const type = r < 0.6 ? "join" : r < 0.75 ? "quit" : "message";
	return {
		id,
		time: new Date(2026, 0, 1, 0, id),
		type,
		self: random() < 0.05,
		highlight: random() < 0.05,
	} as unknown as ClientMessage;
}

describe("Condensed message list", function () {
	it("splits at firstUnread, breaks at self and highlight, unwraps groups of one", function () {
		const m = (id: number, type: string, extra = {}) =>
			({id, time: new Date(2026, 0, 1, 0, id), type, ...extra}) as unknown as ClientMessage;
		const list = [
			m(1, "join"),
			m(2, "join"),
			m(3, "part"),
			m(4, "join"),
			m(5, "join", {self: true}),
			m(6, "quit"),
			m(7, "message"),
			m(8, "join", {highlight: true}),
			m(9, "join"),
		];
		const entries = condenseMessages(list, 2);
		expect(
			entries.map((e) => (e.type === "condensed" ? e.messages.map((x) => x.id) : e.id))
		).to.deep.equal([[1, 2], [3, 4], 5, 6, 7, 8, 9]);
	});

	it("matches a full rebuild through appends, trims, prepends and unread changes", function () {
		for (let seed = 1; seed <= 40; seed++) {
			const random = rng(seed);
			const condenser = new MessageCondenser();
			let messages: ClientMessage[] = [];
			let firstUnread = 0;
			let previous: ReturnType<MessageCondenser["update"]> = [];

			for (let step = 0; step < 300; step++) {
				const r = random();
				let appendedOnly = false;

				if (r < 0.6) {
					// The live case: one or a few messages at the end, trimmed to a limit
					const count = 1 + Math.floor(random() * 3);

					for (let k = 0; k < count; k++) {
						messages.push(message(random));
					}

					appendedOnly = true;

					if (messages.length > 60) {
						messages.splice(0, messages.length - 60);
						appendedOnly = false;
					}
				} else if (r < 0.75) {
					messages.splice(0, Math.floor(random() * 5));
				} else if (r < 0.85) {
					const older = Array.from({length: 1 + Math.floor(random() * 4)}, () =>
						message(random)
					);
					messages = older.concat(messages);
				} else if (r < 0.93 && messages.length) {
					firstUnread = messages[Math.floor(random() * messages.length)].id;
				} else if (r < 0.96) {
					messages = [];
				} else {
					// Replaced by an equal array, as init does
					messages = messages.slice();
				}

				const got = condenser.update(messages, firstUnread);
				expect(got, `seed ${seed} step ${step}`).to.deep.equal(
					condenseMessages(messages, firstUnread)
				);

				if (appendedOnly && previous.length > 1) {
					// Entries before the last one are the very same objects
					for (let i = 0; i < previous.length - 1; i++) {
						expect(got[i]).to.equal(previous[i]);
					}
				}

				previous = got;
			}
		}
	});

	it("does not change groups handed out earlier", function () {
		const condenser = new MessageCondenser();
		const join = (id: number) =>
			({id, time: new Date(2026, 0, 1, 0, id), type: "join"}) as unknown as ClientMessage;
		const messages = [join(1), join(2)];
		const first = condenser.update(messages, 0);
		messages.push(join(3));
		const second = condenser.update(messages, 0);

		expect(first[0]).to.not.equal(second[0]);
		expect(first[0].type === "condensed" && first[0].messages.length).to.equal(2);
		expect(second[0].type === "condensed" && second[0].messages.length).to.equal(3);
		expect(second[0].id).to.equal(3);
	});
});
