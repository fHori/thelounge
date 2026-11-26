import {expect} from "chai";
import {LoginThrottle, ipKey, userKey} from "../../server/login-throttle.js";

describe("Login throttle", function () {
	let now: number;
	const options = {enable: true, ipAttempts: 3, userAttempts: 5, maxDelay: 60};
	const make = (overrides = {}) => new LoginThrottle({...options, ...overrides}, () => now);
	const ip = ipKey("203.0.113.7");
	const user = userKey("Alice");

	beforeEach(function () {
		now = 1_000_000;
	});

	function fail(throttle: LoginThrottle, keys: string[]) {
		expect(throttle.retryAfter(keys)).to.equal(0);
		throttle.attempt(keys);
	}

	it("allows the free attempts, then backs off exponentially", function () {
		const throttle = make();

		for (let i = 0; i < 3; i++) {
			fail(throttle, [ip]);
		}

		expect(throttle.retryAfter([ip])).to.equal(1);
		now += 1000;
		fail(throttle, [ip]);
		expect(throttle.retryAfter([ip])).to.equal(2);
		now += 2000;
		fail(throttle, [ip]);
		expect(throttle.retryAfter([ip])).to.equal(4);
	});

	it("caps the wait at maxDelay", function () {
		const throttle = make();

		for (let i = 0; i < 20; i++) {
			now += 60 * 1000;
			fail(throttle, [ip]);
		}

		expect(throttle.retryAfter([ip])).to.equal(60);
	});

	it("throttles a username across IPs", function () {
		const throttle = make();

		for (let i = 0; i < 5; i++) {
			fail(throttle, [ipKey(`198.51.100.${i}`), user]);
		}

		expect(throttle.retryAfter([ipKey("198.51.100.99"), userKey("ALICE")])).to.equal(1);
		expect(throttle.retryAfter([ipKey("198.51.100.99"), userKey("bob")])).to.equal(0);
	});

	it("counts attempts up front so parallel bursts are limited", function () {
		const throttle = make();
		let admitted = 0;

		for (let i = 0; i < 50; i++) {
			if (throttle.retryAfter([ip, user]) === 0) {
				throttle.attempt([ip, user]);
				admitted++;
			}
		}

		expect(admitted).to.equal(3);
	});

	it("success clears the username and refunds the IP attempt", function () {
		const throttle = make();
		fail(throttle, [ip, user]);
		fail(throttle, [ip, user]);
		fail(throttle, [ip, user]);
		expect(throttle.retryAfter([ip])).to.equal(1);

		now += 1000;
		throttle.attempt([ip, user]);
		throttle.succeed(ip, user);
		expect(throttle.entries.has(user)).to.equal(false);
		expect(throttle.entries.get(ip)!.failures).to.equal(3);
	});

	it("forgets keys after a quiet hour", function () {
		const throttle = make();

		for (let i = 0; i < 4; i++) {
			throttle.attempt([ip]);
		}

		now += 61 * 60 * 1000 + 2000;
		expect(throttle.retryAfter([ip])).to.equal(0);
		expect(throttle.entries.size).to.equal(0);
	});

	it("does nothing when disabled", function () {
		const throttle = make({enable: false});

		for (let i = 0; i < 10; i++) {
			throttle.attempt([ip]);
		}

		expect(throttle.retryAfter([ip])).to.equal(0);
	});

	it("groups IPv6 addresses by /64", function () {
		expect(ipKey("2001:db8:1:2::1")).to.equal(ipKey("2001:db8:1:2:ffff::9"));
		expect(ipKey("2001:db8:1:2::1")).to.not.equal(ipKey("2001:db8:1:3::1"));
		expect(ipKey("::1")).to.equal("ip:0:0:0:0::/64");
		expect(ipKey("10.0.0.1")).to.equal("ip:10.0.0.1");
	});

	it("bounds memory under a username spray", function () {
		const throttle = make();

		for (let i = 0; i < 12000; i++) {
			throttle.attempt([userKey("spray" + i)]);
		}

		expect(throttle.entries.size).to.be.at.most(10000);
	});
});
