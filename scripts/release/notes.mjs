#!/usr/bin/env node
// Release notes from git history, grouped by the merged branch's prefix
// (feat/, fix/, perf/, ...), so no PR labels are needed.
//
//   node scripts/release/notes.mjs --from <ref> --to <ref> --version X [--image I]
//
// Reads first-parent history only: each merged PR is one line, titled by the
// PR title GitHub puts in the merge commit; direct commits are listed as is.
// Tested in test/release/version.ts.

import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {SCHEME} from "./version.mjs";

const GROUPS = [
	["Features", ["feat", "feature", "features", "docker"]],
	["Fixes", ["fix", "bugfix", "hotfix"]],
	["Performance", ["perf"]],
	["Storage", ["storage", "sqlite"]],
	["Security", ["security", "sec"]],
	["Dependencies", ["dependabot", "deps"]],
	["Maintenance", ["chore", "ci", "build", "refactor", "docs", "test", "release"]],
];
const OTHER = "Other changes";

// The message database is migrated on first start when its schema version
// goes up, and older versions can't read it back: that's when to warn
const SCHEMA_FILE = "server/plugins/messageStorage/sqlite.ts";

// The `currentSchemaVersion` a copy of SCHEMA_FILE declares, or null
export function schemaVersion(source) {
	const m = /export const currentSchemaVersion\s*=\s*(\d+)/.exec(source || "");
	return m ? m[1] : null;
}

// Turn one first-parent commit into {group, title, pr}, or null to skip it.
// `pr` is set for pull requests merged from this repository's own branches:
// their number is one of ours. Pull requests from other forks are not linked.
// `pull` is the pull request GitHub says a squash merge came from, see
// lookUpPullRequest(): its branch groups it, as a merge commit's does.
/**
 * @typedef {{number: number, branch: string, own: boolean}} PullRequest
 * @param {{subject: string, body: string, pull?: PullRequest | null}} commit
 * @param {string} [repository]
 */
export function classify({subject, body, pull}, repository = SCHEME.repository) {
	let branch = "";
	let title = subject;
	let pr = null;
	let m;

	if ((m = /^Merge pull request #(\d+) from ([^/\s]+)\/(\S+)/.exec(subject))) {
		branch = m[3];
		title = body.split("\n").find((l) => l.trim()) ?? branch;

		if (m[2].toLowerCase() === repository.split("/")[0].toLowerCase()) {
			pr = Number(m[1]);
		}
	} else if ((m = /^Merge branch '([^']+)'(?: into \S+)?\s*(?:\((.*)\))?$/.exec(subject))) {
		branch = m[1];
		title = m[2] || branch;
	} else if (/^Merge (remote-tracking )?branch /.test(subject)) {
		return null; // syncing merges carry no change of their own
	} else if (/^Release v\d/.test(subject)) {
		return null; // the release workflow's version bump commits
	} else if (pull) {
		branch = pull.branch;
		title = subject.replace(/\s*\(#\d+\)$/, "");
		pr = pull.own ? pull.number : null;
	} else {
		// A squash merge or direct commit. Drop a trailing "(#N)": in history
		// brought in from elsewhere it names another repository's PR.
		title = subject.replace(/\s*\(#\d+\)$/, "");

		if ((m = /^([a-z]+)(?:\([^)]*\))?!?:\s/.exec(subject))) {
			branch = m[1] + "/"; // conventional-commit style subject
		}
	}

	const prefix = branch.includes("/") ? branch.split("/")[0].toLowerCase() : "";
	const group = GROUPS.find(([, prefixes]) => prefixes.includes(prefix))?.[0] ?? OTHER;
	return {group, title: sanitize(title.trim()), pr};
}

// No notifications from release notes: put @mentions and cross-repository
// references in code spans, where GitHub does not link or ping them
export function sanitize(text) {
	return text
		.replace(/`/g, "'")
		.replace(/(^|[^\w`])(@[A-Za-z0-9][\w-]*(?:\/[\w.-]+)?)/g, "$1`$2`")
		.replace(/\b([\w.-]+\/[\w.-]+#\d+)\b/g, "`$1`")
		.replace(/https?:\/\/\S+/g, (u) => "`" + u + "`");
}

// Notes of an automatic base-image refresh release
export function renderRefresh({version, image, refreshOf, baseImage, oldBaseDigest}) {
	return (
		[
			`Docker image: \`${image}:${version}\``,
			"",
			`Base image refresh of ${refreshOf}: **no code changes**. The image was rebuilt` +
				` from the same source on an updated \`${baseImage.split("@")[0]}\` to pick up` +
				" Debian and Node.js security updates.",
			"",
			`- base image now: \`${baseImage}\``,
			`- base image in ${refreshOf}: \`${oldBaseDigest || "unknown"}\``,
			"",
			`See the release notes of ${refreshOf} for its changes.`,
		].join("\n") + "\n"
	);
}

export function render({version, commits, storageChanged, image, repository = SCHEME.repository}) {
	const groups = new Map();

	for (const c of commits) {
		const r = classify(c, repository);

		if (r) {
			const link = r.pr ? ` ([#${r.pr}](https://github.com/${repository}/pull/${r.pr}))` : "";
			groups.set(r.group, [...(groups.get(r.group) ?? []), r.title + link]);
		}
	}

	const out = [];
	out.push(`Docker image: \`${image}:${version}\``);
	out.push("");
	out.push(`Fork of The Lounge, based on stock ${SCHEME.stockBase}.`);

	if (storageChanged) {
		out.push("");
		out.push(
			"> [!WARNING]\n> This release changes message storage. The first start may migrate the" +
				" database in a way older versions cannot read: back up `logs/` (the sqlite files)" +
				" before upgrading, so you can roll back."
		);
	}

	for (const name of [...GROUPS.map(([g]) => g), OTHER]) {
		const items = groups.get(name);

		if (items?.length) {
			out.push("", `## ${name}`, "", ...items.map((t) => `- ${t}`));
		}
	}

	if (!groups.size) {
		out.push("", "No changes since the previous release.");
	}

	return out.join("\n") + "\n";
}

function git(...a) {
	return execFileSync("git", a, {encoding: "utf8", maxBuffer: 64 * 1024 * 1024});
}

// A squash merge's subject ends in the pull request's number
const SQUASHED = /\(#\d+\)$/;

export function readCommits(from, to, lookUp = lookUpPullRequest) {
	const range = from ? `${from}..${to}` : to;
	return git("log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", range)
		.split("\x1e")
		.map((r) => r.replace(/^\n/, ""))
		.filter((r) => r.trim())
		.map((r) => {
			const [sha, subject, body = ""] = r.split("\x1f");
			const pull = SQUASHED.test(subject) ? lookUp(sha) : null;
			return pull ? {subject, body, pull} : {subject, body};
		});
}

let lookUpFailed = false;

/**
 * The pull request a squash merge came from, as {number, branch, own}: git
 * keeps no branch name for it, GitHub does. Null when the commit isn't a pull
 * request merged here, or GitHub can't be asked (no gh, no token); then the
 * commit is grouped by its subject alone.
 */
export function lookUpPullRequest(sha, repository = SCHEME.repository) {
	if (lookUpFailed) {
		return null;
	}

	try {
		const out = execFileSync("gh", ["api", `repos/${repository}/commits/${sha}/pulls`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return pickPullRequest(JSON.parse(out), sha, repository);
	} catch (err) {
		lookUpFailed = true;
		process.stderr.write(
			`Could not look up pull requests (${(err instanceof Error ? err.message : String(err)).split("\n")[0]}); squash merges are grouped by their subject\n`
		);
		return null;
	}
}

// Of the pull requests GitHub lists for a commit, the one merged into this
// repository as that very commit
export function pickPullRequest(pulls, sha, repository = SCHEME.repository) {
	const repo = repository.toLowerCase();
	const pull = (Array.isArray(pulls) ? pulls : []).find(
		(p) => p.merge_commit_sha === sha && p.base?.repo?.full_name?.toLowerCase() === repo
	);

	if (!pull) {
		return null;
	}

	return {
		number: pull.number,
		branch: pull.head.ref,
		own: pull.head.repo?.full_name?.toLowerCase() === repo,
	};
}

function schemaAt(ref) {
	try {
		return schemaVersion(git("show", `${ref}:${SCHEMA_FILE}`));
	} catch {
		return null;
	}
}

// What a release from..to contains, for the version bump: a feature release
// when a merged branch is a feature or the storage schema changed
export function releaseChanges(from, to) {
	const storageChanged = storageChangedBetween(from, to);
	const features = readCommits(from, to).some((c) => classify(c)?.group === "Features");
	return {features: features || storageChanged, storageChanged};
}

function storageChangedBetween(from, to) {
	const before = schemaAt(from || SCHEME.firstReleaseBase);
	const after = schemaAt(to);
	// Warn when unsure: a missing file or declaration counts as a change
	return before === null || after === null || before !== after;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const a = Object.fromEntries(
		process.argv
			.slice(2)
			.join(" ")
			.split(/\s*--/)
			.filter(Boolean)
			.map((s) => [s.split(/\s+/)[0], s.split(/\s+/).slice(1).join(" ")])
	);

	if (a["refresh-of"]) {
		process.stdout.write(
			renderRefresh({
				version: a.version,
				image: a.image || SCHEME.image,
				refreshOf: a["refresh-of"],
				baseImage: a["base-image"],
				oldBaseDigest: a["old-base-digest"],
			})
		);
		process.exit(0);
	}

	const from = a.from || SCHEME.firstReleaseBase;
	const to = a.to || "HEAD";
	process.stdout.write(
		render({
			version: a.version,
			commits: readCommits(from, to),
			storageChanged: storageChangedBetween(from, to),
			image: a.image || SCHEME.image,
		})
	);
}
