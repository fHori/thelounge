import friendlysize from "./friendlysize";
import type {BrowserSearch} from "../searchTiming";
import type {
	Diagnostics,
	SearchLogEntry,
	SearchScanReason,
	StorageDiagnostics,
} from "../../../shared/types/storage";

// What the browser knows about its side
export type BrowserDiagnostics = {
	// Installed as an app (PWA)
	standalone: boolean;
	// "websocket" or "polling"
	transport: string;
	// From asking until the answer arrived, including the server's work
	roundTripMs: number;
	searches: BrowserSearch[];
};

export const scanReasons: Record<SearchScanReason, string> = {
	"index-building": "index building",
	"index-failed": "index failed",
	"short-term": "under 3 chars",
	"common-term": "common term",
};

export const ms = (value: number) =>
	value >= 100 ? `${Math.round(value)} ms` : `${value.toFixed(1)} ms`;

export const percent = (value: number) => `${Math.floor(value * 100)}%`;

export function indexSummary(storage: StorageDiagnostics): string {
	if (storage.storage === "none") {
		return "no history stored";
	}

	if (!storage.open) {
		return "database not open";
	}

	const index = storage.index;

	if (!index) {
		return "unknown";
	}

	switch (index.state) {
		case "complete":
			return "complete";
		case "building":
			return `building ${percent(index.progress ?? 0)}, ~${index.remaining ?? 0} ids left`;
		case "failed":
			return `failed at ${percent(index.progress ?? 0)}: ${index.error ?? "unknown error"}`;
	}
}

export function threadSummary(thread: NonNullable<StorageDiagnostics["thread"]>): string {
	const ping = thread.pingMs === null ? "busy, no answer in 2 s" : `ping ${ms(thread.pingMs)}`;
	const others =
		thread.stores === undefined
			? ""
			: `, ${thread.stores} databases open, ${thread.buildingIndex ?? 0} building an index`;

	return `${ping}, ${thread.waiting} calls waiting${others}`;
}

export function cgroupSummary(cgroup: NonNullable<Diagnostics["server"]["cgroup"]>): string {
	const memory =
		cgroup.memoryLimitBytes === null
			? "no memory limit"
			: `memory ${cgroup.memoryUsedBytes === null ? "?" : friendlysize(cgroup.memoryUsedBytes)} of ${friendlysize(cgroup.memoryLimitBytes)}`;
	const cpus = cgroup.cpus === null ? "no CPU limit" : `${cgroup.cpus} CPUs`;

	return `${memory}, ${cpus}`;
}

export function browserSearchSummary(s: BrowserSearch): string {
	return `${ms(s.waitMs + s.renderMs)} (wait ${ms(s.waitMs)}, render ${ms(s.renderMs)}), ${s.results} results${s.offset ? `, offset ${s.offset}` : ""}`;
}

export function searchSummary(s: SearchLogEntry): string {
	const how = s.reason ? `${s.strategy} (${scanReasons[s.reason]})` : s.strategy;
	const filters = s.filters.length ? ` +${s.filters.join(",")}` : "";
	const candidates = s.candidates === null ? "" : `, ${s.candidates} hits`;
	const work = s.flushMs + s.indexMs + s.queryMs;

	return (
		`${s.termLength} chars${filters} in ${s.scope}: ${how}${candidates}, ` +
		`${s.results} results, ${ms(s.totalMs)} (query ${ms(s.queryMs)}, ` +
		`index ${ms(s.indexMs)}, flush ${ms(s.flushMs)}, queued ${ms(Math.max(0, s.totalMs - work))})`
	);
}

/**
 * The diagnostics as plain text, short enough to paste into a chat.
 */
export function diagnosticsReport(d: Diagnostics, browser: BrowserDiagnostics): string {
	const {server, user, storage} = d;
	const lines: string[] = [];

	lines.push(
		`The Lounge ${server.version}${server.gitCommit ? ` (${server.gitCommit})` : ""}, ` +
			`Node ${server.node}, ${server.platform} ${server.osRelease} ${server.arch}` +
			`${server.container ? ", container" : ""}`
	);
	lines.push(
		`Host: ${server.cpus} CPUs, ${friendlysize(server.memFreeBytes)} free of ` +
			`${friendlysize(server.memTotalBytes)}, up ${Math.round(server.uptimeS / 60)} min, ` +
			`RSS ${friendlysize(server.rssBytes)}, event loop p99 ${ms(server.eventLoop.p99Ms)} ` +
			`max ${ms(server.eventLoop.maxMs)}`
	);
	lines.push(
		`Config: storage ${server.config.messageStorage.join("+") || "none"}, ` +
			`maxHistory ${server.config.maxHistory}, cleanup ${server.config.storagePolicy}`
	);

	if (server.cgroup) {
		lines.push(`Cgroup: ${cgroupSummary(server.cgroup)}`);
	}

	if (server.logsDisk) {
		lines.push(
			`Logs disk: ${server.logsDisk.fsType}, ${friendlysize(server.logsDisk.freeBytes)} free of ` +
				`${friendlysize(server.logsDisk.totalBytes)}`
		);
	}

	lines.push(
		`User: ${user.networks} networks (${user.connectedNetworks} connected), ${user.channels} channels`
	);

	lines.push(`Search index: ${indexSummary(storage)}`);

	if (storage.error) {
		lines.push(`Storage error: ${storage.error}`);
	}

	if (storage.database) {
		const db = storage.database;
		lines.push(
			`Database: ${friendlysize(db.fileBytes)} + WAL ${friendlysize(db.walBytes)}, ` +
				`${percent(db.pages ? db.freePages / db.pages : 0)} free pages, max row id ${db.maxRowId}, ` +
				`${db.journalMode}, cache ${friendlysize(db.cacheKiB * 1024)}, SQLite ${db.sqliteVersion}` +
				`${db.pendingClears ? `, ${db.pendingClears} clears pending` : ""}`
		);
	}

	if (storage.thread) {
		lines.push(`Storage thread: ${threadSummary(storage.thread)}`);
	}

	if (storage.disk) {
		const disk = storage.disk;
		lines.push(
			`Disk reads (${disk.reads}x ${friendlysize(disk.blockBytes)}): median ${ms(disk.medianMs)}, ` +
				`p90 ${ms(disk.p90Ms)}, max ${ms(disk.maxMs)}`
		);
	}

	lines.push(
		`Browser: ${browser.standalone ? "installed app" : "tab"}, ${browser.transport}, ` +
			`round trip ${ms(browser.roundTripMs)}`
	);

	for (const search of storage.searches.slice(0, 5)) {
		lines.push(`Search: ${searchSummary(search)}`);
	}

	for (const search of browser.searches.slice(0, 3)) {
		lines.push(`Browser search: ${browserSearchSummary(search)}`);
	}

	return lines.join("\n");
}
