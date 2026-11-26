import net from "node:net";

// Exponential backoff on failed password logins, per IP (IPv6 per /64) and per
// username. Each key gets some free failures; after that every failure doubles
// the wait before the next attempt, up to maxDelay seconds.

export type LoginThrottleOptions = {
	enable: boolean;
	ipAttempts: number;
	userAttempts: number;
	maxDelay: number;
};

type Entry = {failures: number; last: number};

const MAX_ENTRIES = 10000;

export function ipKey(ip: string) {
	if (net.isIP(ip) !== 6) {
		return "ip:" + ip;
	}

	return "ip:" + expandIPv6(ip).slice(0, 4).join(":") + "::/64";
}

function expandIPv6(ip: string) {
	const [head, tail] = ip.split("::");
	const parse = (part: string | undefined) => (part ? part.split(":") : []);
	const left = parse(head);
	const right = parse(tail);

	// An embedded IPv4 tail never reaches the /64 prefix, so its length is enough
	const missing = 8 - left.length - right.length;
	const groups = [...left, ...Array<string>(Math.max(0, missing)).fill("0"), ...right];
	return groups.map((g) => (parseInt(g, 16) || 0).toString(16));
}

export function userKey(user: string) {
	return "user:" + user.toLowerCase();
}

export class LoginThrottle {
	entries = new Map<string, Entry>();
	options: LoginThrottleOptions;
	now: () => number;

	constructor(options: LoginThrottleOptions, now: () => number = Date.now) {
		this.options = options;
		this.now = now;
	}

	free(key: string) {
		return key.startsWith("user:") ? this.options.userAttempts : this.options.ipAttempts;
	}

	// Milliseconds a key must wait after `failures` failures
	delay(key: string, failures: number) {
		const over = failures - this.free(key);

		if (over < 0) {
			return 0;
		}

		return Math.min(this.options.maxDelay, 2 ** over) * 1000;
	}

	expired(key: string, entry: Entry, now: number) {
		// Forget a key once it has been quiet for an hour past its last lock
		return now - entry.last > this.delay(key, entry.failures) + 60 * 60 * 1000;
	}

	// Seconds until these keys may try again, 0 if allowed now
	retryAfter(keys: string[]) {
		if (!this.options.enable) {
			return 0;
		}

		const now = this.now();
		let wait = 0;

		for (const key of keys) {
			const entry = this.entries.get(key);

			if (!entry) {
				continue;
			}

			if (this.expired(key, entry, now)) {
				this.entries.delete(key);
				continue;
			}

			wait = Math.max(wait, entry.last + this.delay(key, entry.failures) - now);
		}

		return Math.ceil(wait / 1000);
	}

	// Counted as a failure up front, so a burst of parallel attempts can't all
	// get in before the first one fails. succeed() takes it back.
	attempt(keys: string[]) {
		if (!this.options.enable) {
			return;
		}

		const now = this.now();

		for (const key of keys) {
			const entry = this.entries.get(key) ?? {failures: 0, last: now};
			entry.failures++;
			entry.last = now;

			// Re-insert so the map stays in least recently failed order
			this.entries.delete(key);
			this.entries.set(key, entry);
		}

		this.prune();
	}

	succeed(ip: string, user: string) {
		this.entries.delete(user);

		const entry = this.entries.get(ip);

		if (entry) {
			entry.failures--;

			if (entry.failures <= 0) {
				this.entries.delete(ip);
			}
		}
	}

	// The map is in least recently failed order: drop from the front
	prune() {
		for (const key of this.entries.keys()) {
			if (this.entries.size <= MAX_ENTRIES) {
				break;
			}

			this.entries.delete(key);
		}
	}
}
