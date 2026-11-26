import {expect} from "chai";
import semver from "semver";
import * as V from "../../scripts/release/version.mjs";
import * as N from "../../scripts/release/notes.mjs";

const at = (d: string) => new Date(`${d}T12:00:00Z`);
// Every stock tag shape that exists in the inherited history
const stock = ["v1.0.0", "v2.0.0-pre.1", "v3.0.0-rc.6", "v4.4.3", "v4.5.2", "v4.6.0-pre.2"];

describe("release version scheme", function () {
	it("ignores stock tags and starts at YEAR.1.0", function () {
		const r = V.nextVersion({tags: stock, now: at("2026-11-16")});
		expect(r).to.include({
			version: "2026.1.0",
			tag: "v2026.1.0",
			latest: true,
			previousTag: "",
		});
	});

	it("sorts above every stock version, as the semver package does", function () {
		for (const s of stock) {
			expect(semver.gt("2026.1.0", s.slice(1))).to.equal(true);
		}

		const list = [
			"2026.11.0",
			"2026.11.1-rc.1",
			"2026.11.1-rc.10",
			"2026.11.1-rc.2",
			"2026.12.0",
			"2026.11.10",
		];
		expect([...list].sort(V.compare)).to.deep.equal([...list].sort(semver.compare));
	});

	it("bumps the feature number for features and the patch for the rest", function () {
		const tags = [...stock, "v2026.11.0", "v2026.11.1"];
		const next = (o: object): string =>
			V.nextVersion({tags, now: at("2026-11-30"), ...o}).version as string;
		expect(next({})).to.equal("2026.11.2");
		expect(next({features: true})).to.equal("2026.12.0");
		expect(next({bump: "feature"})).to.equal("2026.12.0");
		expect(next({bump: "patch", features: true})).to.equal("2026.11.2");
		// Past 12: the middle number is a count, not a month
		expect(V.nextVersion({tags: ["v2026.12.0"], features: true}).version).to.equal("2026.13.0");
		expect(() => V.nextVersion({tags, bump: "major"})).to.throw();
	});

	it("starts the count again in a new year, but patches keep their year", function () {
		const tags = ["v2026.14.3"];
		const next = (o: object): string =>
			V.nextVersion({tags, now: at("2027-01-05"), ...o}).version as string;
		expect(next({features: true})).to.equal("2027.1.0");
		expect(next({})).to.equal("2026.14.4");
		expect(next({bump: "patch"})).to.equal("2026.14.4");
	});

	it("numbers release candidates and finalises them", function () {
		const tags = ["v2026.11.0", "v2026.11.1-rc.1"];
		const rc = V.nextVersion({tags, prerelease: true, now: at("2026-11-20")});
		expect(rc).to.include({
			version: "2026.11.1-rc.2",
			prerelease: true,
			latest: false,
			previousTag: "v2026.11.1-rc.1",
		});
		const final = V.nextVersion({tags, now: at("2026-11-20")});
		expect(
			V.nextVersion({tags, prerelease: true, features: true, now: at("2026-11-20")}).version
		).to.equal("2026.12.0-rc.1");
		expect(final).to.include({version: "2026.11.1", latest: true, previousTag: "v2026.11.0"});
	});

	it("does not move latest for a fix to an older line", function () {
		const r = V.nextVersion({tags: ["v2026.11.0", "v2026.12.0"], explicit: "v2026.11.1"});
		expect(r).to.include({latest: false, lineLatest: true, exists: false});
		expect(V.nextVersion({tags: ["v2026.11.0"], explicit: "2026.11.0"}).exists).to.equal(true);
	});

	it("rejects versions outside the scheme", function () {
		for (const bad of [
			"4.4.3-hori.1",
			"2026.01.0",
			"2026.0.0",
			"2026.11.0+x",
			"2026.11.0-beta.1",
		]) {
			expect(() => V.nextVersion({tags: [], explicit: bad}), bad).to.throw();
		}
	});

	it("computes image tags per channel", function () {
		const sha = "0123456789abcdef";
		expect(V.imageTags({channel: "edge", sha})).to.deep.equal(["edge", "sha-0123456"]);
		expect(
			V.imageTags({
				channel: "release",
				version: "2026.11.1",
				sha,
				latest: true,
				lineLatest: true,
			})
		).to.deep.equal(["2026.11.1", "sha-0123456", "2026.11", "latest"]);
		expect(V.imageTags({channel: "release", version: "2026.11.1", sha})).to.deep.equal([
			"2026.11.1",
			"sha-0123456",
		]);
		expect(V.imageTags({channel: "prerelease", version: "2026.12.0-rc.1", sha})).to.deep.equal([
			"2026.12.0-rc.1",
			"next",
			"sha-0123456",
		]);
		expect(V.imageTags({channel: "none"})).to.deep.equal([]);
		// a release cut from master is also master's newest build
		expect(
			V.imageTags({channel: "release", version: "2026.11.1", sha, latest: true, edge: true})
		).to.deep.equal(["2026.11.1", "sha-0123456", "latest", "edge"]);
		expect(
			V.imageTags({channel: "prerelease", version: "2026.12.0-rc.1", sha, edge: true})
		).to.include("edge");
		expect(() => V.imageTags({channel: "release", version: "2026.12.0-rc.1", sha})).to.throw();
	});

	it("tags preview builds after their branch, apart from master's", function () {
		const sha = "0123456789abcdef";
		expect(V.imageTags({channel: "preview", branch: "preview/diagnostics", sha})).to.deep.equal(
			["preview-diagnostics", "preview-diagnostics-0123456"]
		);
		expect(() => V.imageTags({channel: "preview", branch: "feat/diagnostics", sha})).to.throw();
		expect(() => V.imageTags({channel: "preview", branch: "preview/x"})).to.throw();
	});

	it("turns preview branch names into tag names", function () {
		expect(V.previewName("preview/diagnostics")).to.equal("diagnostics");
		expect(V.previewName("preview/Search_Speed/v2")).to.equal("search-speed-v2");
		expect(V.previewName("preview/--odd..name--")).to.equal("odd..name");
		expect(V.previewName("preview/" + "a".repeat(200))).to.have.lengthOf(100);
		expect(V.previewName("preview/")).to.equal("");
		expect(V.previewName("preview/___")).to.equal("");
		expect(V.previewName("master")).to.equal("");
		expect(V.previewName("feat/preview/x")).to.equal("");
	});
});

describe("release notes", function () {
	it("groups merged branches by prefix and skips bump commits", function () {
		const body = N.render({
			version: "2026.11.0",
			image: "img",
			storageChanged: true,
			commits: [
				{
					subject: "Merge pull request #14 from someone/perf/fast",
					body: "\nMake it fast\n",
				},
				{
					subject: "Merge pull request #15 from someone/fix/thing",
					body: "Fix @someone's thing, see a/b#3",
				},
				{subject: "Release v2026.10.0", body: ""},
				{subject: "Fix /list paging (#21)", body: ""},
			],
		});
		expect(body).to.include("## Performance\n\n- Make it fast");
		expect(body).to.include("- Fix `@someone`'s thing, see `a/b#3`");
		expect(body).to.include("## Other changes\n\n- Fix /list paging\n");
		expect(body).to.include("[!WARNING]");
		expect(body).not.to.include("Release v2026");
	});

	it("links pull requests merged from this repository, and only those", function () {
		const body = N.render({
			version: "2026.11.0",
			image: "img",
			storageChanged: false,
			repository: "fHori/thelounge",
			commits: [
				{
					subject: "Merge pull request #16 from fHori/fix/upload-auth",
					body: "Require a token",
				},
				{subject: "Merge pull request #10 from someone-else/fix/other", body: "Other fork"},
				{subject: "Fix a thing (#5013)", body: ""},
			],
		});
		expect(body).to.include(
			"- Require a token ([#16](https://github.com/fHori/thelounge/pull/16))"
		);
		expect(body).to.include("- Other fork\n");
		expect(body).to.include("- Fix a thing\n");
		expect(body).not.to.include("5013");
	});

	it("lists dependency updates and Docker changes in their own sections", function () {
		const body = N.render({
			version: "2026.11.0",
			image: "img",
			storageChanged: false,
			commits: [
				{
					subject:
						"Merge pull request #30 from someone/dependabot/npm_and_yarn/minor-and-patch-1a2b3c",
					body: "Bump the minor-and-patch group with 4 updates",
				},
				{subject: "deps: bump undici from 7.30.2 to 7.31.0", body: ""},
				{
					subject: "Merge pull request #26 from someone/docker/puid-pgid",
					body: "Docker: PUID/PGID support",
				},
			],
		});
		expect(body).to.include(
			"## Dependencies\n\n- Bump the minor-and-patch group with 4 updates\n- deps: bump undici"
		);
		expect(body).to.include("## Features\n\n- Docker: PUID/PGID support");
		expect(body).not.to.include("[!WARNING]");
	});

	it("groups squash merges by the branch of their pull request", function () {
		const body = N.render({
			version: "2026.11.5",
			image: "img",
			storageChanged: false,
			repository: "fHori/thelounge",
			commits: [
				{
					subject: "Storage: run SQLite on its own thread (#96)",
					body: "",
					pull: {number: 96, branch: "perf/sqlite-worker", own: true},
				},
				{
					subject: "Tracker avatars (#90)",
					body: "",
					pull: {number: 90, branch: "feat/tracker-avatars", own: false},
				},
				{subject: "Fix a thing (#5013)", body: ""},
			],
		});
		expect(body).to.include(
			"## Features\n\n- Tracker avatars ([#90](https://github.com/fHori/thelounge/pull/90))\n\n## Performance\n\n- Storage: run SQLite on its own thread ([#96](https://github.com/fHori/thelounge/pull/96))\n"
		);
		expect(body).to.include("## Other changes\n\n- Fix a thing\n");
	});

	it("credits pull requests from other people", function () {
		const body = N.render({
			version: "2026.12.0",
			image: "img",
			storageChanged: false,
			repository: "fHori/thelounge",
			commits: [
				{
					subject: "Sync read state with ircv3 draft/read-marker (#108)",
					body: "",
					pull: {
						number: 108,
						branch: "feat/read-marker",
						own: false,
						author: "B4reMetal",
					},
				},
				{
					subject: "Mine (#96)",
					body: "",
					pull: {number: 96, branch: "perf/x", own: true, author: "fHori"},
				},
				{
					subject: "Bump a thing (#97)",
					body: "",
					pull: {
						number: 97,
						branch: "dependabot/x",
						own: true,
						author: "dependabot[bot]",
					},
				},
			],
		});

		expect(body).to.include(
			"- Sync read state with ircv3 draft/read-marker by @B4reMetal ([#108](https://github.com/fHori/thelounge/pull/108))"
		);
		expect(body).to.include("- Mine ([#96](https://github.com/fHori/thelounge/pull/96))");
		expect(body).to.include(
			"- Bump a thing ([#97](https://github.com/fHori/thelounge/pull/97))"
		);
		// The only mention: the credit, none from the owner or bots
		expect(body.match(/@\w/g)).to.have.lengthOf(1);
	});

	it("picks the pull request a squash merge came from", function () {
		const sha = "f34a58263f728a5d05072dfc511b8bd1fae4b375";
		const pull = (number: number, mergeSha: string, base: string, head: string) => ({
			number,
			merge_commit_sha: mergeSha,
			base: {repo: {full_name: base}},
			head: {ref: "perf/x", repo: {full_name: head}},
			user: {login: head.split("/")[0]},
		});

		expect(
			N.pickPullRequest(
				[
					pull(95, "other", "fHori/thelounge", "fHori/thelounge"),
					pull(96, sha, "fHori/thelounge", "fHori/thelounge"),
				],
				sha,
				"fHori/thelounge"
			)
		).to.deep.equal({number: 96, branch: "perf/x", own: true, author: "fHori"});
		expect(
			N.pickPullRequest(
				[pull(96, sha, "fHori/thelounge", "someone/thelounge")],
				sha,
				"fHori/thelounge"
			)
		).to.deep.equal({number: 96, branch: "perf/x", own: false, author: "someone"});
		// Merged somewhere else as this commit, e.g. upstream
		expect(
			N.pickPullRequest(
				[pull(5013, sha, "thelounge/thelounge", "x/thelounge")],
				sha,
				"fHori/thelounge"
			)
		).to.equal(null);
		expect(N.pickPullRequest({message: "Not Found"}, sha, "fHori/thelounge")).to.equal(null);
	});

	it("reads the schema version that decides the storage warning", function () {
		expect(
			N.schemaVersion("export const currentSchemaVersion = 1794820000000; // note")
		).to.equal("1794820000000");
		expect(N.schemaVersion("const other = 1;")).to.equal(null);
		expect(N.schemaVersion(undefined)).to.equal(null);
	});
});
