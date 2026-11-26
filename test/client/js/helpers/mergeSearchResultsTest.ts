import {expect} from "chai";
import mergeSearchResults from "../../../../client/js/helpers/mergeSearchResults.js";
import type {ClientMessage} from "../../../../client/js/types.js";

const message = (id: number, time: number) =>
	({id, time: new Date(time).toISOString(), text: `m${id}`}) as unknown as ClientMessage;

describe("mergeSearchResults helper", function () {
	it("puts batches in order by time, oldest first", function () {
		// Batches come newest stored first; id 9 is playback of something old
		let shown = mergeSearchResults([], [message(9, 100), message(8, 800), message(7, 700)]);
		shown = mergeSearchResults(shown, [message(6, 600), message(5, 500)]);

		expect(shown.map((m) => m.id)).to.deep.equal([9, 5, 6, 7, 8]);
	});

	it("orders messages of the same time by id", function () {
		const shown = mergeSearchResults([message(3, 100)], [message(2, 100), message(4, 100)]);
		expect(shown.map((m) => m.id)).to.deep.equal([2, 3, 4]);
	});

	it("doesn't show a result twice", function () {
		const shown = [message(1, 100), message(2, 200)];
		expect(mergeSearchResults(shown, [message(2, 200)])).to.equal(shown);
		expect(mergeSearchResults(shown, [message(2, 200), message(3, 300)])).to.have.lengthOf(3);
	});

	it("drops duplicates within a batch", function () {
		const shown = mergeSearchResults([], [message(1, 100), message(1, 100), message(2, 100)]);
		expect(shown.map((m) => m.id)).to.deep.equal([1, 2]);
	});

	it("tells apart messages with the same id but another time", function () {
		const shown = mergeSearchResults([message(1, 100)], [message(1, 200)]);
		expect(shown.map((m) => m.time)).to.deep.equal([
			new Date(100).toISOString(),
			new Date(200).toISOString(),
		]);
	});

	it("puts an older page in front without touching the list it was given", function () {
		const shown = [message(10, 1000), message(11, 1100)];
		const merged = mergeSearchResults(shown, [
			message(3, 300),
			message(1, 100),
			message(2, 200),
		]);

		expect(merged.map((m) => m.id)).to.deep.equal([1, 2, 3, 10, 11]);
		expect(shown.map((m) => m.id)).to.deep.equal([10, 11]);
		expect(merged[3]).to.equal(shown[0]);
	});

	it("puts results that fall between shown ones in place", function () {
		const shown = mergeSearchResults(
			[],
			[100, 300, 500, 700].map((t) => message(t, t))
		);
		const merged = mergeSearchResults(shown, [
			message(600, 600),
			message(300, 300),
			message(200, 200),
			message(800, 800),
		]);

		expect(merged.map((m) => m.id)).to.deep.equal([100, 200, 300, 500, 600, 700, 800]);
	});

	it("matches a full sort over many random batches", function () {
		let seed = 1;

		const random = (n: number) => {
			seed = (seed * 16807) % 2147483647;
			return seed % n;
		};

		let shown: ClientMessage[] = [];
		const all = new Map<string, ClientMessage>();

		for (let b = 0; b < 50; b++) {
			const batch = Array.from({length: 1 + random(40)}, () => {
				const m = message(random(200), random(50) * 1000);
				all.set(`${m.id}:${String(m.time)}`, m);
				return m;
			});
			shown = mergeSearchResults(shown, batch);
		}

		const expected = [...all.values()]
			.map((m) => [new Date(m.time).getTime(), m.id])
			.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		expect(shown.map((m) => [new Date(m.time).getTime(), m.id])).to.deep.equal(expected);
	});
});
