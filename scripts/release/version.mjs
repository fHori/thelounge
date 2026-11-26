#!/usr/bin/env node
// Version scheme and image tag policy for releases of this fork.
//
// This file is the one place that defines them; the release, build and image
// refresh workflows only call it. No dependencies, so it runs before
// `yarn install`. Tested by test/release/version.ts.
//
// Scheme: YEAR.FEATURE.PATCH, tagged vYEAR.FEATURE.PATCH.
//   - YEAR is the year the feature release came out; FEATURE counts feature
//     releases within that year, from 1 (2026.11 continues the 2026.11.x
//     releases cut under the old month-based scheme); PATCH counts fix-only
//     releases and base-image refreshes of that feature release.
//   - A release with new features or a storage schema change bumps FEATURE;
//     anything else bumps PATCH. The first feature release of a new year is
//     YEAR.1.0. Patches never change the year: 2026.14.3 -> 2026.14.4.
//   - Pre-releases are YEAR.FEATURE.PATCH-rc.N of the release they lead up to.
//   - Majors of 2000 and above can never be stock The Lounge versions (4.x,
//     5.x, ...), so fork tags never collide with the inherited stock tags, and
//     they sort above every stock version in any semver comparison.
//
// To switch schemes, change SCHEME below (and nextVersion() if the bump rules
// change); the workflows do not need to change as long as tags stay v<semver>.

import {execFileSync} from "node:child_process";
import {appendFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

export const SCHEME = {
	name: "year.feature.patch",
	tagPrefix: "v",
	// Lowest major that counts as a fork version; anything below is a stock tag
	minForkMajor: 2000,
	preId: "rc",
	// The stock release this fork is based on, shown in the release notes.
	// Update it when stock changes are merged in wholesale.
	stockBase: "4.4.3",
	// Where the first release's notes start: the commit of the fork this one
	// is based on (merge-base with tetrahydroc/master). Everything before it
	// is that fork's history, not this fork's changes.
	firstReleaseBase: "83099530",
	image: "ghcr.io/fhori/thelounge",
	// Pull requests merged from this repository are linked in the release notes
	repository: "fHori/thelounge",
};

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parse(version) {
	const m = SEMVER.exec(String(version));

	if (!m) {
		return null;
	}

	return {
		major: Number(m[1]),
		minor: Number(m[2]),
		patch: Number(m[3]),
		pre: m[4] ? m[4].split(".") : [],
		raw: String(version),
	};
}

function cmpIdent(a, b) {
	const an = /^\d+$/.test(a);
	const bn = /^\d+$/.test(b);

	if (an && bn) {
		return Math.sign(Number(a) - Number(b));
	}

	if (an !== bn) {
		return an ? -1 : 1; // numeric identifiers sort before alphanumeric ones
	}

	return a < b ? -1 : a > b ? 1 : 0;
}

// Semver precedence (build metadata ignored)
export function compare(a, b) {
	const x = typeof a === "string" ? parse(a) : a;
	const y = typeof b === "string" ? parse(b) : b;

	for (const k of ["major", "minor", "patch"]) {
		if (x[k] !== y[k]) {
			return Math.sign(x[k] - y[k]);
		}
	}

	if (!x.pre.length || !y.pre.length) {
		return Math.sign(y.pre.length - x.pre.length); // a release sorts after its pre-releases
	}

	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		if (x.pre[i] === undefined) {
			return -1;
		}

		if (y.pre[i] === undefined) {
			return 1;
		}

		const c = cmpIdent(x.pre[i], y.pre[i]);

		if (c) {
			return c;
		}
	}

	return 0;
}

// A valid version of this fork's scheme (stable or rc pre-release)
export function isForkVersion(version) {
	const v = parse(version);

	if (!v || version.includes("+") || v.major < SCHEME.minForkMajor || v.minor < 1) {
		return false;
	}

	return (
		v.pre.length === 0 ||
		(v.pre.length === 2 && v.pre[0] === SCHEME.preId && /^[1-9]\d*$/.test(v.pre[1]))
	);
}

// Fork versions among a list of git tag names, sorted ascending
export function forkVersions(tags) {
	return tags
		.map((t) => t.trim())
		.filter((t) => t.startsWith(SCHEME.tagPrefix))
		.map((t) => t.slice(SCHEME.tagPrefix.length))
		.filter(isForkVersion)
		.sort(compare);
}

// parse() for versions already known to be valid
const must = (v) => {
	const p = parse(v);

	if (!p) {
		throw new Error(`not a version: ${v}`);
	}

	return p;
};

const isStable = (v) => must(v).pre.length === 0;
const line = (v) => `${must(v).major}.${must(v).minor}`;

const core = (v) => {
	const p = must(v);
	return `${p.major}.${p.minor}.${p.patch}`;
};

// Work out the next release.
//   bump "auto":    a feature release when `features` is set (the release
//                   has new features or a storage change), else a patch
//   bump "feature": next feature release: YEAR.FEATURE+1.0, or YEAR.1.0 when
//                   the newest release is from an earlier year
//   bump "patch":   next patch of the newest stable release (a fix-only
//                   release; release from a branch to fix an older line)
//   explicit:       use that version as is (must fit the scheme)
// prerelease adds -rc.N to the version the bump would produce.
export function nextVersion({
	tags,
	bump = "auto",
	explicit = "",
	prerelease = false,
	features = false,
	now = new Date(),
}) {
	const all = forkVersions(tags);
	const stable = all.filter(isStable);
	const newestStable = stable.at(-1);
	let version;

	if (explicit) {
		version = explicit.replace(/^v/, "");

		if (!isForkVersion(version)) {
			throw new Error(
				`"${explicit}" does not fit the version scheme (YEAR.FEATURE.PATCH or YEAR.FEATURE.PATCH-${SCHEME.preId}.N)`
			);
		}

		return describe(version, all);
	}

	if (!["auto", "feature", "patch"].includes(bump)) {
		throw new Error(`unknown bump "${bump}" (expected auto, feature or patch)`);
	}

	const year = now.getUTCFullYear();
	const p = newestStable && parse(newestStable);
	let target;

	if (bump === "patch" || (bump === "auto" && !features && p)) {
		if (!p) {
			throw new Error("bump=patch needs an earlier release; use bump=auto for the first one");
		}

		target = `${p.major}.${p.minor}.${p.patch + 1}`;
	} else if (p && p.major >= year) {
		// Another feature release this year (or the clock is behind the tags)
		target = `${p.major}.${p.minor + 1}.0`;
	} else {
		target = `${year}.1.0`;
	}

	if (prerelease) {
		const rcs = all
			.filter((v) => core(v) === target && !isStable(v))
			.map((v) => Number(must(v).pre[1]));
		version = `${target}-${SCHEME.preId}.${rcs.length ? Math.max(...rcs) + 1 : 1}`;
	} else {
		version = target;
	}

	return describe(version, all);
}

// Facts about a version relative to the existing ones (itself excluded)
export function describe(version, existing) {
	const others = existing.filter((v) => compare(v, version) !== 0);
	const stable = others.filter(isStable);
	const pre = !isStable(version);
	// Notes of a stable release cover everything since the previous stable
	// release (its release candidates included); a pre-release's notes cover
	// everything since the previous tag of either kind.
	const earlier = (pre ? others : stable).filter((v) => compare(v, version) < 0);
	const previous = earlier.at(-1);

	return {
		version,
		tag: SCHEME.tagPrefix + version,
		prerelease: pre,
		exists: others.length !== existing.length,
		// Only the newest stable release moves :latest and its YEAR.FEATURE tag, so a
		// late fix for an older line cannot take them over
		latest: !pre && stable.every((v) => compare(v, version) < 0),
		lineLatest:
			!pre &&
			stable.filter((v) => line(v) === line(version)).every((v) => compare(v, version) < 0),
		line: line(version),
		previousTag: previous ? SCHEME.tagPrefix + previous : "",
	};
}

// Image tags for one publish.
//   edge:       a master push         -> edge, sha-<short>
//   release:    a stable release      -> X.Y.Z, sha-<short>; X.Y when it is the
//               newest of its line, latest when it is the newest release
//   prerelease: a release candidate   -> X.Y.Z-rc.N, next, sha-<short>
//   preview:    a preview/<name> push -> preview-<name>, preview-<name>-<short>
//               (its own sha tag: sha-<short> is for commits on master)
// Weekly base-image refreshes are ordinary releases (a new version), so the
// exact tags X.Y.Z are never re-pushed once published.
// No year-only tag: "2026" would mix feature releases, so it pins nothing useful.
export function imageTags({
	channel,
	version = "",
	sha = "",
	latest = false,
	lineLatest = false,
	edge = false,
	branch = "",
}) {
	const short = sha.slice(0, 7);

	const need = (cond, what) => {
		if (!cond) {
			throw new Error(`channel ${channel} needs ${what}`);
		}
	};

	switch (channel) {
		case "none":
			return [];
		case "edge":
			need(short, "a commit sha");
			return ["edge", `sha-${short}`];

		case "release": {
			need(isForkVersion(version) && isStable(version), "a stable fork version");
			need(short, "a commit sha");
			const tags = [version, `sha-${short}`];

			if (lineLatest) {
				tags.push(line(version));
			}

			if (latest) {
				tags.push("latest");
			}

			// A release cut from master is master's newest commit, but its
			// commit is pushed by the workflow and starts no build of its
			// own: without this, edge would stay behind the release
			if (edge) {
				tags.push("edge");
			}

			return tags;
		}

		case "prerelease":
			need(isForkVersion(version) && !isStable(version), "a fork pre-release version");
			need(short, "a commit sha");
			return [version, "next", `sha-${short}`, ...(edge ? ["edge"] : [])];

		case "preview": {
			const name = previewName(branch);
			need(name, "a preview/<name> branch");
			need(short, "a commit sha");
			return [`preview-${name}`, `preview-${name}-${short}`];
		}

		default:
			throw new Error(`unknown channel "${channel}"`);
	}
}

// The <name> of a preview/<name> branch as it can go into an image tag
// (lowercase letters, digits, ".", "-"), or "" for any other branch.
// preview/Search_Speed/v2 -> search-speed-v2
export function previewName(branch) {
	const match = /^preview\/(.+)$/.exec(branch);

	if (!match) {
		return "";
	}

	const name = match[1]
		.toLowerCase()
		.replace(/[^a-z0-9.]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		// A tag is at most 128 characters: room for "preview-" and "-<short sha>"
		.slice(0, 100)
		.replace(/[-.]+$/, "");

	return name;
}

// ---- command line ----------------------------------------------------------

function args(argv) {
	const out = {};

	for (let i = 0; i < argv.length; i++) {
		const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);

		if (!m) {
			throw new Error(`unexpected argument ${argv[i]}`);
		}

		out[m[1]] =
			m[2] ?? (i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
	}

	return out;
}

const bool = (v) => v === true || v === "true";

function gitTags() {
	return execFileSync("git", ["tag", "--list", `${SCHEME.tagPrefix}*`], {encoding: "utf8"})
		.split("\n")
		.filter(Boolean);
}

// Prints key=value lines, and appends them to $GITHUB_OUTPUT when set
function emit(obj) {
	const lines = Object.entries(obj).map(([key, v]) => {
		const k = key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()); // lineLatest -> line_latest
		return Array.isArray(v) ? `${k}<<EOF\n${v.join("\n")}\nEOF` : `${k}=${v}`;
	});
	process.stdout.write(lines.join("\n") + "\n");

	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
	}
}

// Whether the release since the newest stable tag needs a feature bump
async function hasFeatures(tags) {
	const {releaseChanges} = await import("./notes.mjs");
	const newest = forkVersions(tags).filter(isStable).at(-1);
	return releaseChanges(newest ? SCHEME.tagPrefix + newest : SCHEME.firstReleaseBase, "HEAD")
		.features;
}

async function main(argv) {
	const [cmd, ...rest] = argv;
	const a = args(rest);
	const now = a.date ? new Date(`${a.date}T12:00:00Z`) : new Date();
	const tags = a.tags !== undefined ? a.tags.split(/[\s,]+/).filter(Boolean) : null;

	switch (cmd) {
		// Next release: --bump auto|feature|patch [--version X] [--prerelease]
		//   [--features true|false] [--date YYYY-MM-DD]
		// Without --features, auto reads the history since the newest release
		case "next": {
			const all = tags ?? gitTags();
			const bump = a.bump || "auto";
			const features =
				a.features !== undefined
					? bool(a.features)
					: bump === "auto" && !a.version && (await hasFeatures(all));
			const r = nextVersion({
				tags: all,
				bump,
				features,
				explicit: a.version || "",
				prerelease: bool(a.prerelease),
				now,
			});
			return emit({
				...r,
				features,
				stock_base: SCHEME.stockBase,
				first_base: SCHEME.firstReleaseBase,
			});
		}

		// All fork release tags, oldest first
		case "forks": {
			const list = forkVersions(tags ?? gitTags()).map((v) => SCHEME.tagPrefix + v);
			process.stdout.write(list.length ? list.join("\n") + "\n" : "");
			return;
		}

		// Newest stable release, for the image refresh: empty when there is none
		case "newest": {
			const stable = forkVersions(tags ?? gitTags()).filter(isStable);
			return emit({
				version: stable.at(-1) ?? "",
				tag: stable.length ? SCHEME.tagPrefix + stable.at(-1) : "",
			});
		}

		// Facts about one version: --version X
		case "describe": {
			if (!isForkVersion(a.version || "")) {
				throw new Error(`"${a.version}" does not fit the version scheme`);
			}

			return emit(describe(a.version, forkVersions(tags ?? gitTags())));
		}

		// Image tags: --channel C [--version X] [--sha S] [--latest] [--line-latest] [--edge]
		//   [--branch preview/<name>] [--image I]
		case "image-tags": {
			const list = imageTags({
				channel: a.channel,
				version: a.version || "",
				sha: a.sha || "",
				latest: bool(a.latest),
				lineLatest: bool(a["line-latest"]),
				edge: bool(a.edge),
				branch: a.branch || "",
			});
			const image = a.image || SCHEME.image;
			return emit({tags: list.map((t) => `${image}:${t}`)});
		}

		default:
			throw new Error("usage: version.mjs next|forks|newest|describe|image-tags [--options]");
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((e) => {
		process.stderr.write(`::error::${e.message}\n`);
		process.exit(1);
	});
}
