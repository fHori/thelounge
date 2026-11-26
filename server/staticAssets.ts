import crypto from "crypto";
import fs from "fs";
import path from "path";
import type {NextFunction, Request, Response} from "express";

import Helper from "./helper.js";
import Utils from "./command-line/utils.js";

// Lazy-loaded chunks carry a content hash in their name (see webpack.config.mjs)
const hashedChunk =
	/^\/(?:js\/chunk\.[0-9a-f]{8,}\.js|css\/chunk\.[0-9a-f]{8,}\.css)(?:\.br|\.gz)?$/;

// The ?v= assets in index.html.tpl and the font URLs written by
// scripts/subset-icons.mjs never change for a given URL
export function isVersionedAsset(req: Request) {
	return typeof req.query.v === "string" || hashedChunk.test(req.path);
}

export function setStaticHeaders(res: Response) {
	if (isVersionedAsset(res.req)) {
		res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
	}
}

let cacheBust: string | undefined;

// Version plus build time: a rebuild from the same commit (local edits)
// must not be served from immutable caches
export function getCacheBust() {
	if (cacheBust === undefined) {
		let built = "";

		try {
			built = String(
				fs.statSync(Utils.getFileFromRelativeToRoot("public/js/bundle.js")).mtimeMs
			);
		} catch {
			// no build on disk (tests, dev server)
		}

		cacheBust = crypto
			.createHash("sha256")
			.update(`${Helper.getVersion()} ${built}`)
			.digest("hex")
			.substring(0, 10);
	}

	return cacheBust;
}

const encodings = [
	["br", ".br"],
	["gzip", ".gz"],
] as const;

function findPrecompressed(root: string) {
	const found = new Map<string, Set<string>>();

	const walk = (dir: string) => {
		let entries: fs.Dirent[];

		try {
			entries = fs.readdirSync(dir, {withFileTypes: true});
		} catch {
			return;
		}

		for (const entry of entries) {
			const file = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				walk(file);
				continue;
			}

			for (const [encoding, ext] of encodings) {
				if (entry.name.endsWith(ext)) {
					const original = "/" + path.relative(root, file.slice(0, -ext.length));
					const urlPath = original.split(path.sep).join("/");
					const available = found.get(urlPath) ?? new Set<string>();
					available.add(encoding);
					found.set(urlPath, available);
				}
			}
		}
	};

	walk(root);
	return found;
}

function acceptedEncodings(header: string | undefined) {
	const accepted = new Set<string>();

	for (const part of (header ?? "").split(",")) {
		const [name, ...params] = part.trim().toLowerCase().split(";");
		const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));

		if (name && (!q || parseFloat(q.slice(2)) > 0)) {
			accepted.add(name);
		}
	}

	return accepted;
}

// Serves the .br/.gz files the production build writes next to each asset.
// Must run right before express.static for the same root.
export function precompressed(root: string) {
	const files = findPrecompressed(root);

	return function (req: Request, res: Response, next: NextFunction) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return next();
		}

		const available = files.get(req.path);

		if (!available) {
			return next();
		}

		res.vary("Accept-Encoding");

		// Our order, not the client's: browsers list gzip before br
		const accepted = acceptedEncodings(req.headers["accept-encoding"]);
		const match = encodings.find(([name]) => available.has(name) && accepted.has(name));

		if (!match) {
			return next();
		}

		const [encoding, ext] = match;

		// express.static keeps a Content-Type that is already set
		res.type(path.extname(req.path));
		res.setHeader("Content-Encoding", encoding);
		req.url = req.url.replace(/^[^?]*/, (urlPath) => urlPath + ext);
		return next();
	};
}
