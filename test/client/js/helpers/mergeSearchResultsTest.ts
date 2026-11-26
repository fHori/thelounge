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
});
