import {SharedMsg} from "./msg";

export type SearchQuery = {
	searchTerm: string;
	networkUuid: string;
	channelName: string;
	offset: number;
};

export type SearchResponse = SearchQuery & {
	results: SharedMsg[];
};

// Where a search goes on from, newest first:
// - lookup: below this id among the rows the search index points at
// - scan: below this (time, id) among all messages in scope
export type SearchCursor =
	{kind: "lookup"; beforeId: number} | {kind: "scan"; beforeTime: number; beforeId: number};

// One search, as the browser asks for it: results come back in batches as
// they are found, a page at a time. `cursor` is null for the newest page, or
// the cursor the last page ended with for older results.
export type SearchRequest = {
	id: number;
	searchTerm: string;
	networkUuid: string;
	channelName: string;
	cursor: SearchCursor | null;
};

// Results come in id order, which isn't quite time order (a bouncer's
// playback is stored after newer messages), so the browser sorts them.
// The last message of a page has `done`, and `cursor` for older results,
// null when there are none.
export type SearchResultsChunk = {
	id: number;
	results: SharedMsg[];
	done: boolean;
	cursor: SearchCursor | null;
};

// One step of a search on the storage side
export type SearchBatchQuery = {
	searchTerm: string;
	networkUuid: string;
	channelName: string;
	cursor: SearchCursor | null;
	// Index hits (lookup) or messages (scan) to look at
	rows: number;
};

// How a search found its rows:
// - lookup: read only the rows the search index pointed at, newest first
// - scan: read every message in scope, newest first
export type SearchStrategy = "lookup" | "scan";

// Why a search had to scan
export type SearchScanReason = "index-building" | "index-failed" | "short-term";

export type SearchBatchStats = {
	strategy: SearchStrategy;
	reason?: SearchScanReason;
	// Index hits or messages looked at
	examined: number;
	// Storing queued messages first
	flushMs: number;
	// Asking the index
	indexMs: number;
	// Reading the messages
	queryMs: number;
};

export type SearchStats = SearchBatchStats & {
	batches: number;
	results: number;
	// Until the first result was found, null if none was
	firstMs: number | null;
	// Stopped because a newer search or leaving the results replaced it
	cancelled: boolean;
};

// The term itself is never kept, only its shape
export type SearchLogEntry = SearchStats & {
	at: number;
	// In characters, without the filters
	termLength: number;
	// Names of the filters used, like "from"
	filters: string[];
	scope: "all" | "network" | "channel";
	// Older results ("Show older messages") rather than a new search
	more: boolean;
	// From the request until the page was done, including the waits for the storage thread
	totalMs: number;
};

export type SearchIndexState = {
	state: "complete" | "building" | "failed";
	// 0 to 1 while building
	progress?: number;
	// Messages still to add
	remaining?: number;
	startedAt?: number;
	error?: string;
};

export type DatabaseStats = {
	sqliteVersion: string;
	schemaVersion: number;
	fileBytes: number;
	walBytes: number;
	pageSize: number;
	pages: number;
	freePages: number;
	journalMode: string;
	cacheKiB: number;
	// Ids of rows in the messages table, not of messages as the client knows them
	maxRowId: number;
	// Channels whose cleared history is still being deleted
	pendingClears: number;
};

export type DiskProbe = {
	reads: number;
	blockBytes: number;
	medianMs: number;
	p90Ms: number;
	maxMs: number;
};

export type ServerDiagnostics = {
	version: string;
	gitCommit: string | null;
	node: string;
	platform: string;
	osRelease: string;
	arch: string;
	cpus: number;
	memTotalBytes: number;
	memFreeBytes: number;
	uptimeS: number;
	container: boolean;
	rssBytes: number;
	heapUsedBytes: number;
	// How late the server's thread ran timers, since the last check
	eventLoop: {p50Ms: number; p99Ms: number; maxMs: number};
	config: {
		messageStorage: string[];
		maxHistory: number;
		prefetch: boolean;
		storagePolicy: string;
	};
	// Filesystem holding the logs folder
	logsDisk?: {fsType: string; freeBytes: number; totalBytes: number};
	// Limits of the container or cgroup the server runs in, null when unlimited
	cgroup?: {
		memoryLimitBytes: number | null;
		// Includes the page cache, so near the limit means little room to cache the database
		memoryUsedBytes: number | null;
		cpus: number | null;
	};
};

export type UserDiagnostics = {
	networks: number;
	connectedNetworks: number;
	channels: number;
};

export type Diagnostics = {
	server: ServerDiagnostics;
	user: UserDiagnostics;
	storage: StorageDiagnostics;
};

export type StorageDiagnostics = {
	// "none": history isn't stored (public mode, or sqlite not in messageStorage)
	storage: "sqlite" | "none";
	open: boolean;
	error?: string;
	thread?: {
		// Round trip of an empty call, null if it got no answer in time:
		// the thread is busy, with a long search for instance
		pingMs: number | null;
		// Calls waiting for an answer when the ping was sent
		waiting: number;
		// Databases open on the thread, all users together
		stores?: number;
		// Of those, how many are still building their search index
		buildingIndex?: number;
	};
	database?: DatabaseStats;
	index?: SearchIndexState;
	disk?: DiskProbe;
	searches: SearchLogEntry[];
};
