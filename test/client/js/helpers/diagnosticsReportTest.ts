import {expect} from "chai";
import {
	diagnosticsReport,
	indexSummary,
	searchSummary,
	threadSummary,
} from "../../../../client/js/helpers/diagnosticsReport.js";
import type {Diagnostics, SearchLogEntry} from "../../../../shared/types/storage.js";

const search: SearchLogEntry = {
	at: 0,
	termLength: 7,
	filters: [],
	scope: "all",
	strategy: "scan",
	reason: "index-building",
	examined: 14000000,
	batches: 30,
	results: 2,
	firstMs: 900,
	cancelled: false,
	more: false,
	flushMs: 0.2,
	indexMs: 0,
	queryMs: 19000,
	totalMs: 19500,
};

const diagnostics: Diagnostics = {
	server: {
		version: "2026.11.5",
		gitCommit: null,
		node: "v22.0.0",
		platform: "linux",
		osRelease: "6.1.0",
		arch: "x64",
		cpus: 4,
		memTotalBytes: 8 * 1024 ** 3,
		memFreeBytes: 1024 ** 3,
		uptimeS: 600,
		container: true,
		rssBytes: 200 * 1024 ** 2,
		heapUsedBytes: 100 * 1024 ** 2,
		eventLoop: {p50Ms: 10, p99Ms: 25, maxMs: 120},
		config: {
			messageStorage: ["sqlite"],
			maxHistory: 10000,
			prefetch: true,
			storagePolicy: "off",
		},
		logsDisk: {fsType: "nfs", freeBytes: 1024 ** 4, totalBytes: 2 * 1024 ** 4},
		cgroup: {memoryLimitBytes: 1024 ** 3, memoryUsedBytes: 900 * 1024 ** 2, cpus: 2},
	},
	user: {networks: 3, connectedNetworks: 2, channels: 40},
	storage: {
		storage: "sqlite",
		open: true,
		index: {state: "building", progress: 0.42, remaining: 1000},
		thread: {pingMs: 1.5, waiting: 0},
		database: {
			sqliteVersion: "3.50.0",
			schemaVersion: 1794820000000,
			fileBytes: 2 * 1024 ** 3,
			walBytes: 4 * 1024 ** 2,
			pageSize: 4096,
			pages: 524288,
			freePages: 0,
			journalMode: "wal",
			cacheKiB: 65536,
			maxRowId: 3000000,
			pendingClears: 0,
		},
		searches: [search],
	},
};

describe("diagnosticsReport helper", function () {
	it("sums up the search index", function () {
		expect(indexSummary(diagnostics.storage)).to.equal("building 42%, ~1000 ids left");
		expect(indexSummary({storage: "none", open: false, searches: []})).to.equal(
			"no history stored"
		);
		expect(
			indexSummary({
				storage: "sqlite",
				open: true,
				index: {state: "failed", progress: 0.5, error: "disk I/O error"},
				searches: [],
			})
		).to.equal("failed at 50%: disk I/O error");
	});

	it("says how a search went and where the time went", function () {
		expect(searchSummary(search)).to.equal(
			"7 chars in all: scan (index building), 14000000 rows in 30 batches, 2 results, 19500 ms " +
				"(first 900 ms, query 19000 ms, index 0.0 ms, flush 0.2 ms, queued 500 ms)"
		);
	});

	it("puts everything in a short plain text report", function () {
		const report = diagnosticsReport(diagnostics, {
			standalone: true,
			transport: "websocket",
			roundTripMs: 40,
			searches: [{at: 0, firstMs: 900, waitMs: 19600, renderMs: 80, results: 2, more: false}],
		});

		expect(report).to.include("Search index: building 42%");
		expect(report).to.include("Logs disk: nfs");
		expect(report).to.include("Browser: installed app, websocket, round trip 40.0 ms");
		expect(report).to.include("Search: 7 chars in all: scan (index building)");
		expect(report).to.include("Cgroup: memory 900 MiB of 1 GiB, 2 CPUs");
		expect(report).to.include(
			"Browser search: 19680 ms (first 900 ms, done 19600 ms, render 80.0 ms), 2 results"
		);
		expect(report.split("\n").length).to.be.at.most(20);
	});

	it("marks older pages and cancelled searches", function () {
		expect(searchSummary({...search, more: true, cancelled: true, firstMs: null})).to.match(
			/^7 chars in all, older, cancelled: .*\(no results, /
		);
	});

	it("says when the storage thread is too busy to answer", function () {
		expect(threadSummary({pingMs: null, waiting: 3})).to.equal(
			"busy, no answer in 2 s, 3 calls waiting"
		);
		expect(threadSummary({pingMs: 0.5, waiting: 0, stores: 4, buildingIndex: 1})).to.equal(
			"ping 0.5 ms, 0 calls waiting, 4 databases open, 1 building an index"
		);
	});
});
