import {expect} from "chai";
import {isSearchCursor} from "../../server/searchCursor.js";

describe("Search cursors from the browser", function () {
	it("takes the cursors search hands out", function () {
		expect(isSearchCursor(null)).to.equal(true);
		expect(isSearchCursor({kind: "lookup", beforeId: 12})).to.equal(true);
		expect(isSearchCursor({kind: "scan", beforeTime: 1700000000000, beforeId: 12})).to.equal(
			true
		);
	});

	it("refuses anything else", function () {
		for (const bad of [
			undefined,
			0,
			"lookup",
			[],
			{},
			{kind: "lookup"},
			{kind: "lookup", beforeId: 1.5},
			{kind: "lookup", beforeId: 2 ** 60},
			{kind: "lookup", beforeId: "12"},
			{kind: "lookup", beforeId: 12, extra: 1},
			{kind: "scan", beforeId: 12},
			{kind: "scan", beforeTime: NaN, beforeId: 12},
			{kind: "other", beforeId: 12},
		]) {
			expect(isSearchCursor(bad), JSON.stringify(bad)).to.equal(false);
		}
	});
});
