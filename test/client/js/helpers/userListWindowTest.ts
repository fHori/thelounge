import {expect} from "chai";
import {rowsInView, rowsToDraw} from "../../../../client/js/helpers/userListWindow.js";

describe("userListWindow", function () {
	describe("rowsInView", function () {
		it("gives the rows that overlap the view", function () {
			// Rows of 20px from y=100, view from y=150 to y=250
			expect(rowsInView(1000, 100, 150, 250, 20)).to.deep.equal([2, 8]);
		});

		it("clamps to the group", function () {
			expect(rowsInView(3, 100, 0, 1000, 20)).to.deep.equal([0, 3]);
			expect(rowsInView(10, 5000, 0, 1000, 20)).to.deep.equal([0, 0]);
			expect(rowsInView(10, -5000, 0, 1000, 20)).to.deep.equal([10, 10]);
		});

		it("gives nothing for an empty group or a hidden list", function () {
			expect(rowsInView(0, 0, 0, 500, 20)).to.deep.equal([0, 0]);
			expect(rowsInView(100, 0, 0, 0, 20)).to.deep.equal([0, 0]);
		});
	});

	describe("rowsToDraw", function () {
		it("adds a margin around the rows in view", function () {
			expect(rowsToDraw(1000, [100, 120], undefined, 30)).to.deep.equal([70, 150]);
			expect(rowsToDraw(1000, [5, 20], undefined, 30)).to.deep.equal([0, 50]);
			expect(rowsToDraw(110, [100, 110], undefined, 30)).to.deep.equal([70, 110]);
		});

		it("keeps what is drawn while it covers the view", function () {
			const current = [70, 150] as const;
			expect(rowsToDraw(1000, [80, 100], current, 30)).to.equal(current);
		});

		it("moves once the view leaves what is drawn", function () {
			expect(rowsToDraw(1000, [140, 160], [70, 150], 30)).to.deep.equal([110, 190]);
		});

		it("keeps what is drawn of a group out of view", function () {
			const current = [0, 60] as const;
			expect(rowsToDraw(1000, [0, 0], current, 30)).to.equal(current);
			expect(rowsToDraw(1000, [0, 0], undefined, 30)).to.deep.equal([0, 0]);
		});

		it("drops a range the group has shrunk below", function () {
			expect(rowsToDraw(20, [0, 0], [0, 60], 30)).to.deep.equal([0, 0]);
			expect(rowsToDraw(20, [0, 10], [0, 60], 30)).to.deep.equal([0, 20]);
		});
	});
});
