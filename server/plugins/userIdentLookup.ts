import type Network from "../models/network.js";

export type UserIdent = {ident: string; hostname: string};
export type {UserProfile} from "../../shared/types/profile.js";
import type {UserProfile} from "../../shared/types/profile.js";

// How long a WHOIS reply is kept for profiles
const profileCacheMs = 5 * 60 * 1000;
const maxProfiles = 200;

const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : undefined);

/** The parts of a WHOIS reply a profile shows. */
export function profileFromWhois(data: Record<string, unknown>): UserProfile {
	const profile: UserProfile = {nick: String(data.nick).slice(0, 64)};
	const fields = {
		ident: str(data.ident, 64),
		hostname: str(data.hostname, 255),
		realName: str(data.real_name),
		account: str(data.account, 64),
		server: str(data.server, 255),
		serverInfo: str(data.server_info),
		channels: str(data.channels, 2000),
		away: str(data.away),
	};

	for (const [key, value] of Object.entries(fields)) {
		if (value) {
			profile[key] = value;
		}
	}

	if (typeof data.idle === "number" || typeof data.idle === "string") {
		profile.idle = Number(data.idle) || 0;
	}

	if (typeof data.logon === "number" || typeof data.logon === "string") {
		profile.logon = Number(data.logon) || 0;
	}

	profile.secure = Boolean(data.secure);
	profile.operator = Boolean(data.operator);
	profile.bot = Boolean(data.bot);
	return profile;
}

type Pending = {
	timer: NodeJS.Timeout;
	resolve: ((result: UserIdent | null) => void)[];
	// Cleared when the user asks for a WHOIS of the same nick themself
	// meanwhile, so that reply is shown as usual
	silent: boolean;
	// Whether the "No such nick" error of the WHOIS has been hidden already
	noSuchNickHidden: boolean;
};

// How long a WHOIS sent from here may take to be answered (the client gives
// up after 8 s), and how long a reply that comes later is still kept out of
// the client
const defaultTimeouts = {answerMs: 5000, lateReplyMs: 30000};

type TimedOut = {timer: NodeJS.Timeout; noSuchNickHidden: boolean};

// Lookups that may wait for a WHOIS at once on one network
const maxPendingPerNetwork = 5;

// What could be a nick: no spaces, commas, control characters or wildcards,
// which would make the WHOIS about something else
const nickLike = /^[^\s,*?!@#&:\p{Cc}][^\s,*?!@\p{Cc}]{0,63}$/u;

/**
 * Finds out the ident and hostname of a user on a network, for tracker profile
 * links that are built from them.
 *
 * What the server has already said about the user (in the user list, when they
 * joined or changed host) is used when there is any. Otherwise a WHOIS is sent
 * whose reply is kept out of the client: without this it would open a query
 * window with the reply in it.
 */
class UserIdentLookup {
	private pending = new Map<string, Pending>();
	// Lookups that gave up waiting, whose reply may still come
	private timedOut = new Map<string, TimedOut>();
	// Recent WHOIS replies (silent or shown), for profiles
	private profiles = new Map<string, {at: number; profile: UserProfile}>();

	constructor(private timeouts = defaultTimeouts) {}

	private key(network: Network, nick: string) {
		return `${network.uuid}:${nick.toLowerCase()}`;
	}

	lookup(network: Network, nick: string): Promise<UserIdent | null> {
		if (!nickLike.test(nick)) {
			return Promise.resolve(null);
		}

		for (const chan of network.channels) {
			const user = chan.findUser(nick);

			// Profile addresses take a numeric user id. Anything else may be
			// stale (an ident from before the user identified to the network),
			// so it is asked for again.
			if (user?.ident && user.hostname && /^\d+$/.test(user.ident)) {
				return Promise.resolve({ident: user.ident, hostname: user.hostname});
			}
		}

		return this.send(network, nick);
	}

	/**
	 * A user's profile from WHOIS, without showing the reply. Recent replies
	 * are reused.
	 */
	async profile(network: Network, nick: string): Promise<UserProfile | null> {
		if (!nickLike.test(nick)) {
			return null;
		}

		const key = this.key(network, nick);
		const cached = this.profiles.get(key);

		if (cached && Date.now() - cached.at < profileCacheMs) {
			return cached.profile;
		}

		await this.send(network, nick);
		return this.profiles.get(key)?.profile ?? null;
	}

	private send(network: Network, nick: string): Promise<UserIdent | null> {
		if (!network.irc?.connected) {
			return Promise.resolve(null);
		}

		return new Promise((resolve) => {
			const key = this.key(network, nick);
			const waiting = this.pending.get(key);

			if (waiting) {
				waiting.resolve.push(resolve);
				return;
			}

			const networkPrefix = this.key(network, "");
			const pendingHere = Array.from(this.pending.keys()).filter((k) =>
				k.startsWith(networkPrefix)
			).length;

			if (pendingHere >= maxPendingPerNetwork) {
				resolve(null);
				return;
			}

			this.pending.set(key, {
				timer: setTimeout(() => this.timeOut(key), this.timeouts.answerMs),
				resolve: [resolve],
				silent: true,
				noSuchNickHidden: false,
			});

			network.irc!.raw("WHOIS", nick);
		});
	}

	/**
	 * The user asked for a WHOIS of `nick` themself. Its reply may be the one
	 * a lookup is waiting for, and has to be shown either way.
	 */
	shownWhoisRequested(network: Network, nick: string) {
		const waiting = this.pending.get(this.key(network, nick));

		if (waiting) {
			waiting.silent = false;
		}

		this.forgetTimedOut(this.key(network, nick));
	}

	/**
	 * Takes a "No such nick" error. Returns true if it must not be shown: a
	 * WHOIS of a nick that doesn't exist is answered with one ahead of the
	 * end of the reply, which belongs to the lookup as well. Only one is
	 * taken per lookup, others are about something else.
	 */
	hideNoSuchNick(network: Network, nick: string) {
		const key = this.key(network, nick);
		const waiting = this.pending.get(key) ?? this.timedOut.get(key);

		if (!waiting || ("silent" in waiting && !waiting.silent) || waiting.noSuchNickHidden) {
			return false;
		}

		waiting.noSuchNickHidden = true;
		return true;
	}

	/**
	 * Takes a WHOIS reply. Returns true if it answered a lookup and nothing
	 * else was waiting for it, in which case it must not be shown.
	 */
	handleWhois(
		network: Network,
		data: {
			nick: string;
			error?: boolean;
			whowas?: boolean;
			ident?: unknown;
			hostname?: unknown;
			[key: string]: unknown;
		}
	): boolean {
		// Not the answer to a WHOIS, and about someone who may be gone
		if (data.whowas) {
			return false;
		}

		const key = this.key(network, data.nick);

		if (!data.error) {
			this.profiles.delete(key);
			this.profiles.set(key, {at: Date.now(), profile: profileFromWhois(data)});

			if (this.profiles.size > maxProfiles) {
				this.profiles.delete(this.profiles.keys().next().value!);
			}
		}

		const waiting = this.pending.get(key);
		const late = !waiting && this.timedOut.has(key);

		if (!waiting && !late) {
			return false;
		}

		const known =
			!data.error && typeof data.ident === "string" && typeof data.hostname === "string"
				? {ident: data.ident, hostname: data.hostname}
				: null;

		if (known) {
			// Remember it for the next time, where the user is in a channel
			for (const chan of network.channels) {
				const user = chan.findUser(data.nick);

				if (user) {
					user.ident = known.ident;
					user.hostname = known.hostname;
				}
			}
		}

		if (late) {
			// Answers a lookup that gave up, nobody asked to see it
			this.forgetTimedOut(key);
			return true;
		}

		this.finish(key, known);

		return waiting!.silent;
	}

	private timeOut(key: string) {
		const waiting = this.pending.get(key);

		if (waiting?.silent) {
			this.forgetTimedOut(key);
			this.timedOut.set(key, {
				timer: setTimeout(() => this.timedOut.delete(key), this.timeouts.lateReplyMs),
				noSuchNickHidden: waiting.noSuchNickHidden,
			});
		}

		this.finish(key, null);
	}

	private forgetTimedOut(key: string) {
		const timedOut = this.timedOut.get(key);

		if (timedOut) {
			clearTimeout(timedOut.timer);
			this.timedOut.delete(key);
		}
	}

	private finish(key: string, result: UserIdent | null) {
		const waiting = this.pending.get(key);

		if (!waiting) {
			return;
		}

		clearTimeout(waiting.timer);
		this.pending.delete(key);
		waiting.resolve.forEach((resolve) => resolve(result));
	}

	/**
	 * Drops everything that is waiting, answering it with nothing
	 */
	clear() {
		for (const key of Array.from(this.pending.keys())) {
			this.finish(key, null);
		}

		for (const key of Array.from(this.timedOut.keys())) {
			this.forgetTimedOut(key);
		}
	}
}

export default UserIdentLookup;
