import {expect} from "chai";
import {monitorEventLoopDelay} from "node:perf_hooks";
import Helper from "../../server/helper.js";
import {passwordWorkerCount, terminatePasswordWorkers} from "../../server/password.js";

describe("Client passwords", function () {
	this.slow(1500);

	const inputPassword = "my$Super@Cool Password";

	it("hashed password should match", function () {
		// Generated with third party tool to test implementation
		const comparedPassword = Helper.password.compare(
			inputPassword,
			"$2a$11$zrPPcfZ091WNfs6QrRHtQeUitlgrJcecfZhxOFiQs0FWw7TN3Q1oS"
		);

		return comparedPassword.then((result) => {
			expect(result).to.equal(true);
		});
	});

	it("wrong hashed password should not match", function () {
		// Compare against a fake hash
		const comparedPassword = Helper.password.compare(
			inputPassword,
			"$2a$11$zrPPcfZ091WRONGPASSWORDitlgrJcecfZhxOFiQs0FWw7TN3Q1oS"
		);

		return comparedPassword.then((result) => {
			expect(result).to.equal(false);
		});
	});

	it("freshly hashed password should match", async function () {
		const hashedPassword = await Helper.password.hash(inputPassword);
		expect(hashedPassword).to.match(/^\$2[aby]\$11\$/);
		expect(await Helper.password.compare(inputPassword, hashedPassword)).to.equal(true);
		expect(await Helper.password.compare("wrong", hashedPassword)).to.equal(false);
	});

	it("sync hash for the command line matches", async function () {
		const hashedPassword = Helper.password.hashSync(inputPassword);
		expect(await Helper.password.compare(inputPassword, hashedPassword)).to.equal(true);
	});

	it("non-string input does not match", async function () {
		expect(await Helper.password.compare(undefined as unknown as string, "$2a$11$x")).to.equal(
			false
		);
	});

	it("verifies in a worker without blocking the event loop", async function () {
		this.timeout(10000);
		const hash = "$2a$11$zrPPcfZ091WNfs6QrRHtQeUitlgrJcecfZhxOFiQs0FWw7TN3Q1oS";
		const histogram = monitorEventLoopDelay({resolution: 5});
		histogram.enable();

		const results = await Promise.all(
			Array.from({length: 6}, (_, i) =>
				Helper.password.compare(i % 2 ? inputPassword : "nope", hash)
			)
		);

		histogram.disable();
		expect(results).to.deep.equal([false, true, false, true, false, true]);
		expect(passwordWorkerCount()).to.be.greaterThan(0);
		// On the main thread each compare holds the loop for ~100 ms
		expect(histogram.max / 1e6).to.be.lessThan(60);
	});

	it("starts new workers after they were stopped", async function () {
		await terminatePasswordWorkers();
		expect(passwordWorkerCount()).to.equal(0);
		const hash = "$2a$11$zrPPcfZ091WNfs6QrRHtQeUitlgrJcecfZhxOFiQs0FWw7TN3Q1oS";
		expect(await Helper.password.compare(inputPassword, hash)).to.equal(true);
	});

	it("shout passwords should be marked as old", function () {
		expect(
			Helper.password.requiresUpdate(
				"$2a$08$K4l.hteJcCP9D1G5PANzYuBGvdqhUSUDOLQLU.xeRxTbvtp01KINm"
			)
		).to.equal(true);
		expect(
			Helper.password.requiresUpdate(
				"$2a$11$zrPPcfZ091WNfs6QrRHtQeUitlgrJcecfZhxOFiQs0FWw7TN3Q1oS"
			)
		).to.equal(false);
	});
});
