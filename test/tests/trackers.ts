import {expect} from "chai";
import _ from "lodash";

import Config, {ConfigType} from "../../server/config.js";
import log from "../../server/log.js";
import defaultConfig from "../../defaults/config.js";

describe("Config trackers", function () {
	let saved: ConfigType["trackers"];
	let warn: typeof log.warn;
	let warnings: string[];

	beforeEach(function () {
		saved = _.cloneDeep(Config.values.trackers);
		// eslint-disable-next-line @typescript-eslint/unbound-method
		warn = log.warn;
		warnings = [];
		log.warn = (...args: string[]) => warnings.push(args.join(" "));

		Config.values.trackers = {
			SP: {
				name: "Seedpool",
				network: "irc.seedpool.org",
				profileUrl: "https://seedpool.org/users/{nick}",
			},
			BLU: {
				name: "Blutopia",
				network: "irc.p2p-network.net",
				channels: ["#blutopia"],
				profileUrl: "https://blutopia.cc/users/{nick}",
			},
			OTH: {
				name: "Other",
				network: "irc.p2p-network.net",
				profileUrl: "https://other.example/u/{nick}/profile",
			},
			NOL: {name: "No link", network: "irc.nolink.example"},
			OFF: {name: "Off", network: "irc.off.example", disabled: true},
		};
	});

	afterEach(function () {
		Config.values.trackers = saved;
		log.warn = warn;
	});

	describe("getTrackersForHost", function () {
		it("returns undefined for unknown hosts, a missing host, or no trackers", function () {
			expect(Config.getTrackersForHost("irc.unknown.example")).to.equal(undefined);
			expect(Config.getTrackersForHost(undefined)).to.equal(undefined);
			Config.values.trackers = null;
			expect(Config.getTrackersForHost("irc.seedpool.org")).to.equal(undefined);
		});

		it("matches the host case-insensitively", function () {
			expect(Config.getTrackersForHost("IRC.SeedPool.org")).to.deep.equal([
				{id: "SP", name: "Seedpool", profileUrl: "https://seedpool.org/users/{nick}"},
			]);
		});

		it("also matches the name the server gave, as bouncers pass it on", function () {
			// A ZNC on its own host, in front of Seedpool
			expect(
				Config.getTrackersForHost("znc.example.net", "IRC.Seedpool.org")!.map((t) => t.id)
			).to.deep.equal(["SP"]);
			expect(Config.getTrackersForHost("znc.example.net", "irc.znc.in")).to.equal(undefined);
			expect(Config.getTrackersForHost(undefined, "irc.seedpool.org")!.length).to.equal(1);
			expect(Config.getTrackersForHost("irc.seedpool.org", "")!.length).to.equal(1);
		});

		it("returns every tracker sharing a network, with its channels", function () {
			const trackers = Config.getTrackersForHost("irc.p2p-network.net")!;

			expect(trackers.map((t) => t.id)).to.deep.equal(["BLU", "OTH"]);
			expect(trackers[0].channels).to.deep.equal(["#blutopia"]);
			expect(trackers[1].profileUrl).to.equal("https://other.example/u/{nick}/profile");
		});

		it("skips disabled and removed trackers", function () {
			expect(Config.getTrackersForHost("irc.off.example")).to.equal(undefined);
			Config.values.trackers!.SP = null;
			expect(Config.getTrackersForHost("irc.seedpool.org")).to.equal(undefined);
		});

		it("keeps a tracker without a profile address, for bridge scoping", function () {
			expect(Config.getTrackersForHost("irc.nolink.example")).to.deep.equal([
				{id: "NOL", name: "No link"},
			]);
		});

		it("leaves out profile addresses that can't become a link", function () {
			for (const profileUrl of [
				"https://seedpool.org/users/",
				"javascript:alert('{nick}')",
				"seedpool.org/users/{nick}",
			]) {
				Config.values.trackers!.SP!.profileUrl = profileUrl;
				expect(Config.getTrackersForHost("irc.seedpool.org")![0]).to.not.have.property(
					"profileUrl"
				);
			}
		});

		it("passes on addresses built from the ident, with the users' hostname", function () {
			Config.values.trackers!.SP = {
				name: "Seedpool",
				network: "irc.seedpool.org",
				profileUrl: "https://seedpool.org/user.php?id={ident}",
				userHost: "*.seedpool.org",
			};

			expect(Config.getTrackersForHost("irc.seedpool.org")).to.deep.equal([
				{
					id: "SP",
					name: "Seedpool",
					profileUrl: "https://seedpool.org/user.php?id={ident}",
					userHost: "*.seedpool.org",
				},
			]);
		});

		it("ships defaults that load and resolve", function () {
			Config.values.trackers = _.cloneDeep(defaultConfig.trackers);

			expect(Config.getTrackersForHost("irc.seedpool.org")).to.deep.equal([
				{
					id: "SP",
					name: "Seedpool",
					profileUrl: "https://seedpool.org/users/{nick}",
				},
			]);
			// No profiles by nick there, the entry only scopes the bridge matcher
			expect(Config.getTrackersForHost("irc.gazellegames.net")![0].profileUrl).to.equal(
				"https://gazellegames.net/user.php?id={ident}"
			);
			expect(Config.getTrackersForHost("irc.nebulance.io")![0]).to.not.have.property(
				"profileUrl"
			);
		});
	});

	describe("merging a user config", function () {
		const merge = (config: Record<string, unknown>) =>
			Config.merge(config as unknown as ConfigType);

		it("adds, changes and removes single trackers, keeping the rest", function () {
			merge({
				trackers: {
					EX: {name: "Example", network: "irc.example.org"},
					SP: {profileUrl: "https://seedpool.org/user/{nick}"},
					BLU: null,
				},
			});

			const trackers = Config.values.trackers!;

			expect(trackers.EX).to.deep.equal({name: "Example", network: "irc.example.org"});
			expect(trackers.SP).to.deep.equal({
				name: "Seedpool",
				network: "irc.seedpool.org",
				profileUrl: "https://seedpool.org/user/{nick}",
			});
			expect(trackers.BLU).to.equal(null);
			expect(trackers.OTH!.name).to.equal("Other");
			expect(warnings).to.deep.equal([]);
		});

		it("replaces a tracker's channel list instead of adding to it", function () {
			merge({trackers: {BLU: {channels: ["#blu"]}}});

			expect(Config.values.trackers!.BLU!.channels).to.deep.equal(["#blu"]);
		});

		it("turns everything off with null", function () {
			merge({trackers: null});

			expect(Config.values.trackers).to.equal(null);
		});

		it("still reads a torrentSites list, which replaces the built-in trackers", function () {
			merge({
				defaultTorrentSiteInfo: {profileUrl: "/u/"},
				torrentSites: [
					{
						abbreviation: "EX",
						name: "Example",
						host: "irc.example.org",
						domain: "example.org",
						channels: ["#example"],
					},
					{
						abbreviation: "PTH",
						name: "Path",
						host: "irc.path.example",
						domain: "path.example",
						profileUrl: "profile/",
					},
					{
						abbreviation: "NOL",
						name: "No link",
						host: "irc.nolink.example",
						domain: "nolink.example",
						profileLink: false,
					},
					{
						disabled: true,
						abbreviation: "OFF",
						name: "Off",
						host: "irc.off.example",
						domain: "off.example",
					},
				],
			});

			expect(Config.values.trackers).to.deep.equal({
				EX: {
					name: "Example",
					network: "irc.example.org",
					channels: ["#example"],
					profileUrl: "https://example.org/u/{nick}",
				},
				PTH: {
					name: "Path",
					network: "irc.path.example",
					profileUrl: "https://path.example/profile/{nick}",
				},
				NOL: {name: "No link", network: "irc.nolink.example"},
				OFF: {
					name: "Off",
					network: "irc.off.example",
					disabled: true,
					profileUrl: "https://off.example/u/{nick}",
				},
			});
			expect(warnings).to.have.lengthOf(1);
			expect(warnings[0]).to.include("torrentSites").and.not.include("Unknown key");
		});

		it("takes no config at all, as when started without -c options", function () {
			const before = Config.values.trackers;
			Config.merge(undefined as unknown as ConfigType);

			expect(Config.values.trackers).to.equal(before);
		});

		it("turns everything off for torrentSites: null", function () {
			merge({torrentSites: null});

			expect(Config.values.trackers).to.equal(null);
		});
	});
});
