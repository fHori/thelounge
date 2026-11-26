import _ from "lodash";
import type {SearchCursor} from "../shared/types/storage.js";

// A cursor the browser hands back from an earlier page, or null. Its
// numbers go into queries, so only safe integers: the database refuses
// larger ones.
export function isSearchCursor(value: unknown): value is SearchCursor | null {
	if (value === null) {
		return true;
	}

	if (!_.isPlainObject(value)) {
		return false;
	}

	const cursor = value as Record<string, unknown>;

	switch (cursor.kind) {
		case "lookup":
			return Object.keys(cursor).length === 2 && Number.isSafeInteger(cursor.beforeId);
		case "scan":
			return (
				Object.keys(cursor).length === 3 &&
				Number.isSafeInteger(cursor.beforeTime) &&
				Number.isSafeInteger(cursor.beforeId)
			);
		default:
			return false;
	}
}
