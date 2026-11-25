import {expect} from "chai";
import {
	parseThemeOptions,
	parseThemeOptionsSetting,
	resolveThemeOptionValues,
	sanitizeThemeOptionsSetting,
	themeOptionAttribute,
	themeOptionLimits,
} from "../../shared/themeOptions.js";
import {authorName, parseRecommends, sourceUrl} from "../../server/plugins/packages/themes.js";

const manifest = {
	messageDisplay: {
		type: "select",
		label: "Message display",
		description: "Cozy shows avatars.",
		default: "compact",
		choices: {compact: "Compact", cozy: "Cozy"},
		css: {cozy: "cozy.css"},
	},
	nickAvatars: {type: "boolean", label: "Nick avatars", default: true},
	accent: {type: "color", label: "Accent", default: "#5865F2", cssVar: "--accent"},
	radius: {
		type: "range",
		label: "Radius",
		default: 8,
		min: 0,
		max: 20,
		unit: "px",
		cssVar: "--r",
	},
};

describe("theme options", function () {
	describe("parseThemeOptions", function () {
		it("accepts a valid manifest", function () {
			const {options, errors} = parseThemeOptions(manifest, ["cozy.css"]);
			expect(errors).to.deep.equal([]);
			expect(Object.keys(options)).to.deep.equal([
				"messageDisplay",
				"nickAvatars",
				"accent",
				"radius",
			]);
			expect(options.messageDisplay).to.deep.include({css: {cozy: "cozy.css"}});
			expect(options.accent).to.deep.include({default: "#5865f2", cssVar: "--accent"});
			expect(options.radius).to.deep.include({min: 0, max: 20, step: 1, unit: "px"});
		});

		it("returns nothing when no options are declared", function () {
			expect(parseThemeOptions(undefined)).to.deep.equal({options: {}, errors: []});
		});

		it("leaves out invalid options and says why", function () {
			const {options, errors} = parseThemeOptions(
				{
					"bad-key": {type: "boolean", label: "x", default: true},
					noLabel: {type: "boolean", default: true},
					badType: {type: "text", label: "x", default: ""},
					badDefault: {type: "select", label: "x", default: "c", choices: {a: "A"}},
					badColor: {type: "color", label: "x", default: "red"},
					badRange: {type: "range", label: "x", default: 5, min: 10, max: 1},
					varOnBool: {type: "boolean", label: "x", default: true, cssVar: "--x"},
					badVar: {type: "color", label: "x", default: "#000000", cssVar: "x;}"},
					unlistedCss: {
						type: "boolean",
						label: "x",
						default: false,
						css: {true: "other.css"},
					},
					pathCss: {type: "boolean", label: "x", default: false, css: {true: "../x.css"}},
					ok: {type: "boolean", label: "x", default: false},
				},
				["cozy.css", "../x.css"]
			);
			expect(Object.keys(options)).to.deep.equal(["ok"]);
			expect(errors).to.have.length(10);
			expect(errors.join("\n")).to.contain('"unlistedCss"');
		});

		it("caps the number of options", function () {
			const many = Object.fromEntries(
				Array.from({length: 40}, (_, i) => [
					`o${i}`,
					{type: "boolean", label: "x", default: false},
				])
			);
			const {options, errors} = parseThemeOptions(many);
			expect(Object.keys(options)).to.have.length(themeOptionLimits.options);
			expect(errors).to.have.length(1);
		});
	});

	describe("values", function () {
		const {options} = parseThemeOptions(manifest, ["cozy.css"]);

		it("uses stored values when valid, defaults otherwise", function () {
			expect(
				resolveThemeOptionValues(options, {
					messageDisplay: "cozy",
					nickAvatars: "yes",
					accent: "#ff0000",
					radius: 99,
				})
			).to.deep.equal({
				messageDisplay: "cozy",
				nickAvatars: true,
				accent: "#ff0000",
				radius: 8,
			});
		});

		it("reads a malformed setting as empty", function () {
			expect(parseThemeOptionsSetting("{nope")).to.deep.equal({});
			expect(parseThemeOptionsSetting("[]")).to.deep.equal({});
			expect(parseThemeOptionsSetting('{"a":{"x":1},"b":3}')).to.deep.equal({a: {x: 1}});
		});

		it("server keeps only valid non-default values, and other themes' values", function () {
			const schemaFor = (t: string) =>
				t === "discord" ? options : t === "default" ? {} : undefined;
			const clean = sanitizeThemeOptionsSetting(
				JSON.stringify({
					discord: {messageDisplay: "cozy", nickAvatars: true, accent: "nope", extra: 1},
					default: {x: true},
					uninstalled: {foo: "bar", nested: {a: 1}},
					empty: {},
				}),
				schemaFor
			);
			expect(JSON.parse(clean as string)).to.deep.equal({
				discord: {messageDisplay: "cozy"},
				uninstalled: {foo: "bar"},
			});
		});

		it("server rejects oversized or malformed settings", function () {
			expect(sanitizeThemeOptionsSetting("x".repeat(20000), () => undefined)).to.equal(null);
			expect(sanitizeThemeOptionsSetting("[1]", () => undefined)).to.equal(null);
			expect(sanitizeThemeOptionsSetting(5, () => undefined)).to.equal(null);
			expect(sanitizeThemeOptionsSetting("", () => undefined)).to.equal("");
			expect(sanitizeThemeOptionsSetting('{"a":{}}', () => undefined)).to.equal("");
		});

		it("turns keys into data attributes", function () {
			expect(themeOptionAttribute("messageDisplay")).to.equal("data-theme-message-display");
		});
	});

	describe("package info", function () {
		it("shows the author's name, never the email", function () {
			expect(authorName("fHori <a@b.c> (https://x.y)")).to.equal("fHori");
			expect(authorName({name: "fHori", email: "a@b.c"})).to.equal("fHori");
			expect(authorName(5)).to.equal(undefined);
		});

		it("turns repository forms into an https link", function () {
			expect(
				sourceUrl({
					type: "git",
					url: "git+https://github.com/fHori/thelounge-theme-discord.git",
				})
			).to.equal("https://github.com/fHori/thelounge-theme-discord");
			expect(sourceUrl("github:fHori/x")).to.equal("https://github.com/fHori/x");
			expect(sourceUrl("fHori/x")).to.equal("https://github.com/fHori/x");
			expect(sourceUrl("gitlab:a/b")).to.equal("https://gitlab.com/a/b");
			expect(sourceUrl("http://example.com/x")).to.equal(undefined);
			expect(sourceUrl("javascript:alert(1)")).to.equal(undefined);
			expect(sourceUrl("https://user:pw@example.com/x")).to.equal(undefined);
		});
	});

	describe("recommended packages", function () {
		it("takes names or {name, description, install}, and drops anything odd", function () {
			expect(
				parseRecommends([
					"thelounge-tracker-avatars",
					{
						name: "@scope/pkg",
						description: "nice",
						install: "thelounge install github:owner/pkg",
					},
					{name: "Not Valid"},
					{name: "evil", install: "rm -rf /"},
					42,
				])
			).to.deep.equal([
				{name: "thelounge-tracker-avatars"},
				{
					name: "@scope/pkg",
					description: "nice",
					install: "thelounge install github:owner/pkg",
				},
				{name: "evil"},
			]);
			expect(parseRecommends("nope")).to.deep.equal([]);
		});
	});
});
