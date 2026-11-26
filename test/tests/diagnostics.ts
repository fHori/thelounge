import fs from "fs";
import os from "os";
import path from "path";
import {expect} from "chai";
import Config from "../../server/config.js";
import {cgroupLimits, scrub, serverDiagnostics} from "../../server/diagnostics.js";

describe("Diagnostics", function () {
	it("takes paths, addresses and the user's name out of messages", function () {
		const logs = Config.getUserLogsPath();

		expect(scrub(`SqliteError: unable to open ${logs}/alice.sqlite3`, "alice")).to.equal(
			"SqliteError: unable to open <logs>/<user>.sqlite3"
		);
		expect(scrub(`EACCES: ${os.homedir()}/x`)).to.equal("EACCES: ~/x");
		expect(scrub("connect ECONNREFUSED 192.168.1.20:6697")).to.equal(
			"connect ECONNREFUSED <ip>:6697"
		);
		expect(scrub("from 2001:db8::1 and fe80::1")).to.equal("from <ip> and <ip>");
		expect(scrub("took until 12:30:45")).to.equal("took until 12:30:45");
		// Too short to replace without mangling other words
		expect(scrub("no such table", "no")).to.equal("no such table");
	});

	it("reads container limits from cgroup v2 and v1", function () {
		if (process.platform !== "linux") {
			this.skip();
		}

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thelounge-cgroup-"));

		try {
			fs.writeFileSync(path.join(dir, "memory.max"), "1073741824\n");
			fs.writeFileSync(path.join(dir, "memory.current"), "536870912\n");
			fs.writeFileSync(path.join(dir, "cpu.max"), "150000 100000\n");
			expect(cgroupLimits(dir)).to.deep.equal({
				memoryLimitBytes: 1073741824,
				memoryUsedBytes: 536870912,
				cpus: 1.5,
			});

			fs.writeFileSync(path.join(dir, "memory.max"), "max\n");
			fs.writeFileSync(path.join(dir, "cpu.max"), "max 100000\n");
			expect(cgroupLimits(dir)).to.include({memoryLimitBytes: null, cpus: null});

			for (const file of ["memory.max", "memory.current", "cpu.max"]) {
				fs.rmSync(path.join(dir, file));
			}

			fs.mkdirSync(path.join(dir, "memory"));
			fs.mkdirSync(path.join(dir, "cpu"));
			fs.writeFileSync(
				path.join(dir, "memory/memory.limit_in_bytes"),
				"9223372036854771712\n"
			);
			fs.writeFileSync(path.join(dir, "cpu/cpu.cfs_quota_us"), "200000\n");
			fs.writeFileSync(path.join(dir, "cpu/cpu.cfs_period_us"), "100000\n");
			expect(cgroupLimits(dir)).to.deep.equal({
				memoryLimitBytes: null,
				memoryUsedBytes: null,
				cpus: 2,
			});
		} finally {
			fs.rmSync(dir, {recursive: true, force: true});
		}
	});

	it("reports the server without anything identifying", function () {
		const server = serverDiagnostics();

		expect(server.node).to.equal(process.version);
		expect(server.cpus).to.be.greaterThan(0);
		expect(server.eventLoop.maxMs).to.be.at.least(0);
		expect(server.config.messageStorage).to.be.an("array");

		const text = JSON.stringify(server);
		expect(text).to.not.include(os.hostname());
		expect(text).to.not.include(Config.getHomePath());
	});
});
