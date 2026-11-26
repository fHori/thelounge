import {expect} from "chai";
import sinon from "sinon";
import Config from "../server/config.js";
import {StorageCleaner} from "../server/storageCleaner.js";
import type {DeletionRequest} from "../server/plugins/messageStorage/types.js";

describe("Storage cleaner", function () {
	let clock: sinon.SinonFakeTimers;
	let originalPolicy: typeof Config.values.storagePolicy;

	beforeEach(function () {
		originalPolicy = Config.values.storagePolicy;
		Config.values.storagePolicy = {enabled: true, maxAgeDays: 7, deletionPolicy: "statusOnly"};
		clock = sinon.useFakeTimers();
	});

	afterEach(function () {
		clock.restore();
		Config.values.storagePolicy = originalPolicy;
	});

	// A database with `backlog` old rows, each row taking `msPerRow` to delete
	function fakeDb(backlog: number, msPerRow: number) {
		const limits: number[] = [];
		const db = {
			isEnabled: true,
			deleteMessages(req: DeletionRequest) {
				limits.push(req.limit);
				const rows = Math.min(backlog, req.limit);
				backlog -= rows;
				// Time passes without running any timers
				clock.setSystemTime(Date.now() + rows * msPerRow);
				return Promise.resolve(rows);
			},
			get left() {
				return backlog;
			},
		};
		return {db, limits};
	}

	it("should clear a backlog in passes sized to take about 20ms", async function () {
		const {db, limits} = fakeDb(1000000, 0.01); // 100 rows/ms
		const cleaner = new StorageCleaner(db);
		cleaner.start();

		// A minute of passes clears it all, where 200 rows every 5s took days
		await clock.tickAsync(60 * 1000);
		cleaner.stop();

		expect(db.left).to.equal(0);
		expect(limits.slice(0, 5)).to.deep.equal([200, 400, 800, 1600, 2000]); // at most twofold
		expect(Math.max(...limits)).to.equal(2000); // 2000 rows is 20ms
	});

	it("should make passes smaller when they take long", async function () {
		const {db, limits} = fakeDb(1000000, 1);
		const cleaner = new StorageCleaner(db);
		cleaner.start();

		await clock.tickAsync(10 * 1000);
		cleaner.stop();

		expect(limits[0]).to.equal(200);
		expect(limits[1]).to.equal(100); // the smallest pass
	});

	it("should wait minutes once the backlog is gone", async function () {
		const {db, limits} = fakeDb(150, 0.01);
		const cleaner = new StorageCleaner(db);
		cleaner.start();

		await clock.tickAsync(1000);
		expect(limits).to.have.lengthOf(1);
		expect(db.left).to.equal(0);

		await clock.tickAsync(5 * 60 * 1000);
		cleaner.stop();
		expect(limits).to.have.lengthOf(2);
	});
});
