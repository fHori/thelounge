import {messageKey} from "../../../shared/messageKey";
import type {ClientMessage} from "../types";

/**
 * Adds a batch of search results to those shown, oldest first. Batches
 * arrive in the order they were stored, which isn't quite time order (a
 * bouncer's playback is stored after newer messages), so every result is
 * put in its place by time. A result already shown isn't added twice.
 */
export default function mergeSearchResults(
	shown: ClientMessage[],
	batch: ClientMessage[]
): ClientMessage[] {
	const keys = new Set(shown.map(messageKey));
	const added = batch.filter((message) => !keys.has(messageKey(message)));

	if (!added.length) {
		return shown;
	}

	const time = (message: ClientMessage) => new Date(message.time).getTime();
	return [...shown, ...added].sort((a, b) => time(a) - time(b) || a.id - b.id);
}
