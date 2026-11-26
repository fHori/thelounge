// Cuts the Font Awesome fonts down to the icons The Lounge uses.
//
//   node scripts/subset-icons.mjs          writes the subset fonts, the
//                                          @font-face rules and the preload link
//   node scripts/subset-icons.mjs --check  fails if the sources use an icon the
//                                          subset leaves out (run by the tests)
//
// The full fonts stay next to the subsets (*-full.woff2) and cover every other
// codepoint through unicode-range, so a theme using an icon left out here still
// renders it, at the cost of downloading the full font.
/* eslint-disable no-console */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fontDir = path.join(root, "client/fonts/font-awesome");
const cssFile = path.join(root, "client/css/fontawesome7.css");
const tplFile = path.join(root, "client/index.html.tpl");

const fonts = [
	{name: "fa-regular-400", weight: 400},
	{name: "fa-solid-900", weight: 900, preload: true},
];

// Icons used by themes outside this repository, kept so those do not pull the full font
const themeExtras = [
	0xf03e, 0xf053, 0xf054, 0xf060, 0xf078, 0xf118, 0xf14e, 0xf15b, 0xf1f6, 0xf201, 0xf2bd,
];

const beginMarker = "/* subset-icons:begin */";
const endMarker = "/* subset-icons:end */";
const preloadPattern = /^\t<link rel="preload" as="font"[^\n]*\n/m;

function listSources(dir) {
	return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
		const file = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			return listSources(file);
		}

		return /\.(css|vue)$/.test(entry.name) ? [file] : [];
	});
}

// Codepoints written as CSS escapes ("\f00d") in the Private Use Area
export function usedCodepoints() {
	const codepoints = new Set(themeExtras);

	for (const file of listSources(path.join(root, "client"))) {
		let text = fs.readFileSync(file, "utf8");

		if (file === cssFile) {
			text = text.replace(new RegExp(`${escape(beginMarker)}[^]*${escape(endMarker)}`), "");
		}

		for (const [, hex] of text.matchAll(/\\([0-9a-fA-F]{4,6})(?![0-9a-fA-F])/g)) {
			const cp = parseInt(hex, 16);

			if (cp >= 0xe000 && cp <= 0xf8ff) {
				codepoints.add(cp);
			}
		}
	}

	return [...codepoints].sort((a, b) => a - b);
}

function escape(text) {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

export function unicodeRange(codepoints) {
	const ranges = [];

	for (const cp of codepoints) {
		const last = ranges.at(-1);

		if (last && last[1] === cp - 1) {
			last[1] = cp;
		} else {
			ranges.push([cp, cp]);
		}
	}

	const hex = (cp) => cp.toString(16).toUpperCase();
	return ranges.map(([a, b]) => (a === b ? `U+${hex(a)}` : `U+${hex(a)}-${hex(b)}`)).join(", ");
}

const fileHash = (file) =>
	crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 8);

const fontUrl = (file) => `fonts/font-awesome/${file}?v=${fileHash(path.join(fontDir, file))}`;

function fontFaces(codepoints) {
	const face = (weight, file, range) => `@font-face {
	font-family: "Font Awesome 7 Pro";
	font-style: normal;
	font-weight: ${weight};
	font-display: swap;
	src: url("../${fontUrl(file)}") format("woff2");${range ? `\n\tunicode-range: ${range};` : ""}
}`;

	// The last matching rule wins, so the full font only loads for codepoints the subset lacks
	const rules = fonts.flatMap(({name, weight}) => [
		face(weight, `${name}-full.woff2`),
		face(weight, `${name}.woff2`, unicodeRange(codepoints)),
	]);

	return `${beginMarker}\n${rules.join("\n\n")}\n\n${endMarker}`;
}

function preloadLinks() {
	return fonts
		.filter((font) => font.preload)
		.map(
			({name}) =>
				`\t<link rel="preload" as="font" type="font/woff2" crossorigin href="${fontUrl(`${name}.woff2`)}">\n`
		)
		.join("");
}

function replaceBlock(css, block) {
	const start = css.indexOf(beginMarker);
	const end = css.indexOf(endMarker);

	if (start === -1 || end === -1) {
		throw new Error(`${cssFile} lacks the ${beginMarker} ... ${endMarker} block`);
	}

	return css.slice(0, start) + block + css.slice(end + endMarker.length);
}

function withPreload(tpl) {
	const cleaned = tpl.replace(preloadPattern, "");
	const anchor = '\t<link rel="stylesheet" href="css/style.css';
	return cleaned.replace(anchor, preloadLinks() + anchor);
}

// Returns a list of problems, empty when the committed files match the sources
export function check() {
	const codepoints = usedCodepoints();
	const problems = [];
	const css = fs.readFileSync(cssFile, "utf8");

	if (replaceBlock(css, fontFaces(codepoints)) !== css) {
		problems.push(`${path.relative(root, cssFile)} is out of date`);
	}

	const tpl = fs.readFileSync(tplFile, "utf8");

	if (withPreload(tpl) !== tpl) {
		problems.push(`${path.relative(root, tplFile)} preload is out of date`);
	}

	return problems;
}

async function write() {
	const {default: subsetFont} = await import("subset-font");
	const codepoints = usedCodepoints();
	const text = String.fromCodePoint(...codepoints);

	for (const {name} of fonts) {
		const full = fs.readFileSync(path.join(fontDir, `${name}-full.woff2`));
		const subset = await subsetFont(full, text, {targetFormat: "woff2"});
		fs.writeFileSync(path.join(fontDir, `${name}.woff2`), subset);
		console.log(`${name}.woff2: ${full.length} -> ${subset.length} bytes`);
	}

	fs.writeFileSync(
		cssFile,
		replaceBlock(fs.readFileSync(cssFile, "utf8"), fontFaces(codepoints))
	);
	fs.writeFileSync(tplFile, withPreload(fs.readFileSync(tplFile, "utf8")));
	console.log(`${codepoints.length} icons`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--check")) {
		const problems = check();

		for (const problem of problems) {
			console.error(`${problem}: run node scripts/subset-icons.mjs`);
		}

		process.exitCode = problems.length ? 1 : 0;
	} else {
		await write();
	}
}
