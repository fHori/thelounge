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

// How a search found its rows:
// - lookup: read only the rows the search index pointed at
// - filter: walked messages newest first, skipping what the index ruled out
// - scan: walked messages newest first, reading every one until a page was full
export type SearchStrategy = "lookup" | "filter" | "scan";

// Why a search had to scan
export type SearchScanReason = "index-building" | "index-failed" | "short-term" | "common-term";

export type SearchStats = {
	strategy: SearchStrategy;
	reason?: SearchScanReason;
	// Rows the index said could match, null when it wasn't asked
	candidates: number | null;
	results: number;
	// Storing queued messages first
	flushMs: number;
	// Asking the index
	indexMs: number;
	// Reading the messages
	queryMs: number;
};

// The term itself is never kept, only its shape
export type SearchLogEntry = SearchStats & {
	at: number;
	// In characters, without the filters
	termLength: number;
	// Names of the filters used, like "from"
	filters: string[];
	scope: "all" | "network" | "channel";
	// From the request until the answer, including the wait for the storage thread
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
