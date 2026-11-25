import fs from "fs";
import path from "path";
import _ from "lodash";

import log from "../../log.js";
import Config from "../../config.js";
import Utils from "../../command-line/utils.js";
import {parseThemeOptions, ThemeOptions} from "../../../shared/themeOptions.js";
import {parseFeatureValues, type FeatureValues} from "../../../shared/features.js";

type Module = {
	type?: string;
	name?: string;
};

type ThemeModule = Module & {
	type: "theme";
	themeColor: string;
	css: string;
	files?: string[];
	options?: unknown;
	features?: unknown;
	client?: unknown;
	recommends?: unknown;
	// From package.json itself, not its "thelounge" field
	author?: unknown;
	repository?: unknown;
	homepage?: unknown;
};

export type ThemeRecommendation = {
	name: string;
	description?: string;
	// How to install it, shown as given (default: `thelounge install <name>`)
	install?: string;
	installed?: boolean;
};

const packageNameRegex = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** A theme's "recommends": package names, or {name, description, install}. */
export function parseRecommends(raw: unknown): ThemeRecommendation[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	const result: ThemeRecommendation[] = [];

	for (const entry of raw.slice(0, 5)) {
		const item: Record<string, unknown> =
			typeof entry === "string"
				? {name: entry}
				: entry && typeof entry === "object"
					? entry
					: {};

		if (
			typeof item.name !== "string" ||
			item.name.length > 214 ||
			!packageNameRegex.test(item.name)
		) {
			continue;
		}

		const rec: ThemeRecommendation = {name: item.name};

		if (typeof item.description === "string" && item.description.length <= 200) {
			rec.description = item.description;
		}

		if (
			typeof item.install === "string" &&
			item.install.length <= 200 &&
			/^thelounge install \S+$/.test(item.install)
		) {
			rec.install = item.install;
		}

		result.push(rec);
	}

	return result;
}

export type ThemeForClient = {
	displayName: string;
	filename?: string;
	name: string;
	themeColor: string | null;
	options?: ThemeOptions;
	// Feature defaults for this theme's users (see shared/features.ts)
	features?: FeatureValues;
	// The theme's client module, a file among its public files
	client?: string;
	// Packages that go well with the theme; `installed` is filled in per request
	recommends?: ThemeRecommendation[];
	author?: string;
	repositoryUrl?: string;
};

const themes = new Map<string, ThemeForClient>();

export default {
	addTheme,
	getAll,
	getByName,
	loadLocalThemes,
};

function loadLocalThemes() {
	const builtInThemes = fs.readdirSync(Utils.getFileFromRelativeToRoot("public", "themes"));

	builtInThemes
		.filter((theme) => theme.endsWith(".css"))
		.map(makeLocalThemeObject)
		.forEach((theme) => themes.set(theme.name, theme));
}

function addTheme(packageName: string, packageObject: ThemeModule) {
	const theme = makePackageThemeObject(packageName, packageObject);

	if (theme) {
		themes.set(theme.name, theme);
	}
}

function getAll() {
	const filteredThemes: ThemeForClient[] = [];

	for (const theme of themes.values()) {
		filteredThemes.push(
			_.pick(theme, [
				"displayName",
				"name",
				"themeColor",
				"options",
				"features",
				"client",
				"recommends",
				"author",
				"repositoryUrl",
			])
		);
	}

	return _.sortBy(filteredThemes, "displayName");
}

function getByName(name: string) {
	return themes.get(name);
}

function makeLocalThemeObject(css: string) {
	const themeName = css.slice(0, -4);
	return {
		displayName: themeName.charAt(0).toUpperCase() + themeName.slice(1),
		name: themeName,
		themeColor: null,
	};
}

function makePackageThemeObject(
	moduleName: string,
	module: ThemeModule
): ThemeForClient | undefined {
	if (!module || module.type !== "theme") {
		return;
	}

	const themeColor = /^#[0-9A-F]{6}$/i.test(module.themeColor) ? module.themeColor : null;
	const modulePath = Config.getPackageModulePath(moduleName);
	const theme: ThemeForClient = {
		displayName: module.name || moduleName,
		filename: path.join(modulePath, module.css),
		name: encodeURIComponent(moduleName),
		themeColor: themeColor,
	};

	const {options, errors} = parseThemeOptions(module.options, module.files || []);

	for (const error of errors) {
		log.warn(`Theme ${moduleName}: ${error}`);
	}

	if (Object.keys(options).length > 0) {
		theme.options = options;
	}

	const recommends = parseRecommends(module.recommends);

	if (recommends.length > 0) {
		theme.recommends = recommends;
	}

	const featureDefaults = parseFeatureValues(module.features);

	if (Object.keys(featureDefaults).length > 0) {
		theme.features = featureDefaults;
	}

	if (module.client !== undefined) {
		const files = module.files || [];

		if (
			typeof module.client === "string" &&
			/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}\.m?js$/.test(module.client) &&
			files.includes(module.client)
		) {
			theme.client = module.client;
		} else {
			log.warn(
				`Theme ${moduleName}: "client" must be a .js file listed in the package's "files"`
			);
		}
	}

	const author = authorName(module.author);
	const repositoryUrl = sourceUrl(module.repository) || sourceUrl(module.homepage);

	if (author) {
		theme.author = author;
	}

	if (repositoryUrl) {
		theme.repositoryUrl = repositoryUrl;
	}

	return theme;
}

// A package.json field that is either a string or an object with `key`
const stringOr = (value: unknown, key: string): unknown =>
	typeof value === "string"
		? value
		: value && typeof value === "object"
			? (value as Record<string, unknown>)[key]
			: undefined;

/** package.json "author": "Name <email> (url)" or {name}. Never the email. */
export function authorName(author: unknown): string | undefined {
	const raw = stringOr(author, "name");

	if (typeof raw !== "string") {
		return undefined;
	}

	// "Name <email> (url)": the name is what comes before either
	const name = raw.split(/[<(]/, 1)[0].trim();
	return name && name.length <= 80 ? name : undefined;
}

/**
 * package.json "repository" (string, {url}, "github:owner/repo" or
 * "owner/repo") or "homepage", as an https URL to show, or undefined.
 */
export function sourceUrl(repository: unknown): string | undefined {
	const picked = stringOr(repository, "url");

	if (typeof picked !== "string" || picked.length > 300) {
		return undefined;
	}

	let raw = picked.trim();
	const shorthand = /^(?:(github|gitlab|bitbucket):)?([\w.-]+)\/([\w.-]+)$/.exec(raw);

	if (shorthand) {
		const host = {github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org"}[
			shorthand[1] || "github"
		];
		return `https://${host}/${shorthand[2]}/${shorthand[3].replace(/\.git$/, "")}`;
	}

	raw = raw.replace(/^git\+/, "").replace(/^git:\/\//, "https://");

	try {
		const url = new URL(raw);

		if (url.protocol !== "https:" || url.username || url.password) {
			return undefined;
		}

		url.pathname = url.pathname.replace(/\.git$/, "");
		url.hash = "";
		return url.href;
	} catch {
		return undefined;
	}
}
