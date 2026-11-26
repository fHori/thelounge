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
