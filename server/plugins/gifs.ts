import log from "../log.js";
import Config from "../config.js";
import outgoingFetch from "./outgoingFetch.js";

/**
 * GIF search for the message box's GIF picker. The server asks the provider
 * (Giphy or Tenor) so browsers never talk to it, results are cached briefly, and
 * each user is rate limited. A picked GIF is sent as a plain link.
 */

export type {Gif, GifMedia, GifPage, GifProvider, Gifs} from "../../shared/types/gifs.js";
import type {Gif, GifPage, GifProvider} from "../../shared/types/gifs.js";

export const gifLimits = {
	perPage: 30,
	queryLength: 100,
	searchesPerMinute: 30,
	cacheMs: 10 * 60 * 1000,
	cacheEntries: 300,
	timeoutMs: 8000,
};

const cache = new Map<string, {at: number; page: GifPage}>();
const recent = new Map<string, number[]>(); // user → search times

/** The configured provider, or null when GIFs are off or have no key. */
export function gifProvider(): GifProvider | null {
	const gifs = Config.values.gifs;

	if (!gifs?.enable) {
		return null;
	}

	if (gifs.provider === "tenor" && gifs.tenorKey) {
		return "tenor";
	}

	if (gifs.provider === "giphy" && gifs.giphyKey) {
		return "giphy";
	}

	return null;
}

/** Per-user limit: true when the search may go ahead. */
export function allowGifSearch(user: string, now = Date.now()): boolean {
	const times = (recent.get(user) || []).filter((t) => now - t < 60000);

	if (times.length >= gifLimits.searchesPerMinute) {
		recent.set(user, times);
		return false;
	}

	times.push(now);
	recent.set(user, times);
	return true;
}

const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

const httpsUrl = (v: unknown) => {
	const s = str(v);
	return s.startsWith("https://") ? s : "";
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

export function parseGiphy(json: unknown): GifPage {
	const root = obj(json);
	const data = Array.isArray(root.data) ? root.data : [];
	const items: Gif[] = [];

	for (const raw of data) {
		const item = obj(raw);
		const images = obj(item.images);
		const small = obj(images.fixed_width);
		const send = obj(images.downsized).url ? obj(images.downsized) : obj(images.original);
		const preview = httpsUrl(small.url);
		const url = httpsUrl(send.url);

		if (!preview || !url) {
			continue;
		}

		items.push({
			id: str(item.id),
			title: str(item.title),
			preview: {
				url: preview,
				width: num(small.width),
				height: num(small.height),
				mp4: httpsUrl(small.mp4) || undefined,
			},
			url,
		});
	}

	const pagination = obj(root.pagination);
	const offset = num(pagination.offset) + num(pagination.count);
	const next = offset < num(pagination.total_count) && items.length ? String(offset) : null;
	return {items, next};
}

export function parseTenor(json: unknown): GifPage {
	const root = obj(json);
	const results = Array.isArray(root.results) ? root.results : [];
	const items: Gif[] = [];

	for (const raw of results) {
		const item = obj(raw);
		// v2: media_formats {tinygif, gif, tinymp4}; v1: media[0] {tinygif, gif, tinymp4}
		const formats = item.media_formats
			? obj(item.media_formats)
			: obj(Array.isArray(item.media) ? item.media[0] : undefined);
		const small = obj(formats.tinygif);
		const send = obj(formats.gif);
		const dims = Array.isArray(small.dims) ? small.dims : [];
		const preview = httpsUrl(small.url);
		const url = httpsUrl(send.url);

		if (!preview || !url) {
			continue;
		}

		items.push({
			id: str(item.id),
			title: str(item.content_description) || str(item.title),
			preview: {
				url: preview,
				width: num(dims[0]),
				height: num(dims[1]),
				mp4: httpsUrl(obj(formats.tinymp4).url) || undefined,
			},
			url,
		});
	}

	const next = str(root.next);
	return {items, next: next && next !== "0" && items.length ? next : null};
}

function tenorFilter(rating: string) {
	return {g: "high", pg: "medium", "pg-13": "low", r: "off"}[rating] || "low";
}

function requestUrl(provider: GifProvider, query: string, pos: string | null): string {
	const gifs = Config.values.gifs;
	const params = new URLSearchParams();

	if (provider === "giphy") {
		params.set("api_key", gifs.giphyKey);
		params.set("limit", String(gifLimits.perPage));
		params.set("rating", gifs.rating || "pg-13");

		if (pos) {
			params.set("offset", pos);
		}

		if (query) {
			params.set("q", query);
			return `https://api.giphy.com/v1/gifs/search?${params.toString()}`;
		}

		return `https://api.giphy.com/v1/gifs/trending?${params.toString()}`;
	}

	// Tenor: keys from Google Cloud ("AIza…") use v2, older Tenor keys v1
	const v2 = gifs.tenorKey.startsWith("AIza");
	params.set("key", gifs.tenorKey);
	params.set("limit", String(gifLimits.perPage));
	params.set("contentfilter", tenorFilter(gifs.rating));

	if (v2) {
		params.set("client_key", "thelounge");
		params.set("media_filter", "tinygif,gif,tinymp4");
	} else {
		params.set("media_filter", "minimal");
	}

	if (pos) {
		params.set("pos", pos);
	}

	const base = v2 ? "https://tenor.googleapis.com/v2" : "https://g.tenor.com/v1";

	if (query) {
		params.set("q", query);
		return `${base}/search?${params.toString()}`;
	}

	return `${base}/${v2 ? "featured" : "trending"}?${params.toString()}`;
}

/** Search (or trending, for an empty query). Throws on provider errors. */
export async function searchGifs(query: string, pos: string | null = null): Promise<GifPage> {
	const provider = gifProvider();

	if (!provider) {
		return {items: [], next: null};
	}

	const q = query.trim().slice(0, gifLimits.queryLength);
	const key = `${provider}\n${q.toLowerCase()}\n${pos || ""}`;
	const hit = cache.get(key);

	if (hit && Date.now() - hit.at < gifLimits.cacheMs) {
		return hit.page;
	}

	const res = await outgoingFetch(requestUrl(provider, q, pos), {
		signal: AbortSignal.timeout(gifLimits.timeoutMs),
		headers: {Accept: "application/json"},
	});

	if (!res.ok) {
		log.warn(`GIFs: ${provider} answered HTTP ${res.status}`);
		throw new Error(`HTTP ${res.status}`);
	}

	const json: unknown = await res.json();
	const page = provider === "giphy" ? parseGiphy(json) : parseTenor(json);

	if (cache.size >= gifLimits.cacheEntries) {
		const oldest = cache.keys().next().value;

		if (oldest !== undefined) {
			cache.delete(oldest);
		}
	}

	cache.set(key, {at: Date.now(), page});
	return page;
}

/** For tests */
export function resetGifs() {
	cache.clear();
	recent.clear();
}
