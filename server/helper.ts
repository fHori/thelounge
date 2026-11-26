import pkg from "../package.json" with {type: "json"};
import _ from "lodash";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import {
	passwordCompare,
	passwordHash,
	passwordHashSync,
	passwordRequiresUpdate,
} from "./password.js";
import {execSync} from "node:child_process";

export type Hostmask = {
	nick: string;
	ident: string;
	hostname: string;
};

const Helper = {
	expandHome,
	getVersion,
	getVersionNumber,
	getGitCommit,
	ip2hex,
	parseHostmask,
	compareHostmask,
	compareWithWildcard,
	catch_to_error,
	unshiftMany,

	password: {
		hash: passwordHash,
		hashSync: passwordHashSync,
		compare: passwordCompare,
		requiresUpdate: passwordRequiresUpdate,
	},
};

export default Helper;

function getVersion() {
	const gitCommit = getGitCommit();
	const version = `v${pkg.version}`;

	if (gitCommit) {
		return `source (${gitCommit} / ${version})`;
	}

	// Docker images have no .git; the build records the commit instead
	const buildCommit = process.env.THELOUNGE_BUILD_COMMIT?.slice(0, 7);
	return buildCommit ? `${version} (${buildCommit})` : version;
}

function getVersionNumber() {
	return pkg.version;
}

let _fetchedGitCommit = false;
let _gitCommit: string | null = null;

function getGitCommit() {
	if (_fetchedGitCommit) {
		return _gitCommit;
	}

	_fetchedGitCommit = true;

	// --git-dir ".git" makes git only check current directory for `.git`, and not travel upwards
	// We set cwd to the location of `index.js` as soon as the process is started
	try {
		_gitCommit = execSync(
			'git --git-dir ".git" rev-parse --short HEAD', // Returns hash of current commit
			{stdio: ["ignore", "pipe", "ignore"]}
		)
			.toString()
			.trim();
		return _gitCommit;
	} catch {
		// Not a git repository or git is not installed
		_gitCommit = null;
		return null;
	}
}

function ip2hex(address: string) {
	// no ipv6 support
	if (!net.isIPv4(address)) {
		return "00000000";
	}

	return address
		.split(".")
		.map(function (octet) {
			let hex = parseInt(octet, 10).toString(16);

			if (hex.length === 1) {
				hex = "0" + hex;
			}

			return hex;
		})
		.join("");
}

// Expand ~ into the current user home dir.
// This does *not* support `~other_user/tmp` => `/home/other_user/tmp`.
function expandHome(shortenedPath: string | undefined) {
	if (!shortenedPath) {
		return "";
	}

	// A replacer function, so a `$` in the home dir is never read as a
	// replacement pattern
	return path.resolve(
		shortenedPath.replace(/^~($|\/|\\)/, (_match, sep: string) => os.homedir() + sep)
	);
}

function parseHostmask(hostmask: string): Hostmask {
	let nick = "";
	let ident = "*";
	let hostname = "*";
	let parts: string[] = [];

	// Parse hostname first, then parse the rest
	parts = hostmask.split("@");

	if (parts.length >= 2) {
		hostname = parts[1] || "*";
		hostmask = parts[0];
	}

	hostname = hostname.toLowerCase();

	parts = hostmask.split("!");

	if (parts.length >= 2) {
		ident = parts[1] || "*";
		hostmask = parts[0];
	}

	ident = ident.toLowerCase();

	nick = hostmask.toLowerCase() || "*";

	const result = {
		nick: nick,
		ident: ident,
		hostname: hostname,
	};

	return result;
}

function compareHostmask(a: Hostmask, b: Hostmask) {
	return (
		compareWithWildcard(a.nick, b.nick) &&
		compareWithWildcard(a.ident, b.ident) &&
		compareWithWildcard(a.hostname, b.hostname)
	);
}

function compareWithWildcard(a: string, b: string) {
	// we allow '*' and '?' wildcards in our comparison.
	// this is mostly aligned with https://modern.ircdocs.horse/#wildcard-expressions
	// but we do not support the escaping. The ABNF does not seem to be clear as to
	// how to escape the escape char '\', which is valid in a nick,
	// whereas the wildcards tend not to be (as per RFC1459).

	// The "*" wildcard is ".*" in regex, "?" is "."
	// so we tokenize and join with the proper char back together,
	// escaping any other regex modifier
	const wildmany_split = a.split("*").map((sub) => {
		const wildone_split = sub.split("?").map((p) => _.escapeRegExp(p));
		return wildone_split.join(".");
	});
	const user_regex = wildmany_split.join(".*");
	const re = new RegExp(`^${user_regex}$`, "i"); // case insensitive
	return re.test(b);
}

function catch_to_error(prefix: string, err: unknown): Error {
	let msg: string;

	if (err instanceof Error) {
		msg = err.message;
	} else if (typeof err === "string") {
		msg = err;
	} else {
		msg = String(err);
	}

	return new Error(`${prefix}: ${msg}`);
}

// `target.unshift(...items)` passes every item as a call argument and throws
// "Maximum call stack size exceeded" once there are too many of them (roughly
// 120k in V8). History batches can get that large, so prepend in slices.
function unshiftMany<T>(target: T[], items: T[]): void {
	const chunkSize = 10000;

	for (let end = items.length; end > 0; end -= chunkSize) {
		target.unshift(...items.slice(Math.max(0, end - chunkSize), end));
	}
}
