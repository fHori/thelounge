import type {ClientMessage} from "../types";

// Each message's time in ms, parsed once. Results are compared every time a
// batch comes in, and parsing an ISO date is most of a comparison's cost.
const times = new WeakMap<ClientMessage, number>();

function timeOf(message: ClientMessage): number {
	let time = times.get(message);

	if (time === undefined) {
		time = new Date(message.time).getTime();
		times.set(message, time);
	}

	return time;
}

// Time, then id. Messages that compare equal have the same messageKey.
function compare(a: ClientMessage, b: ClientMessage): number {
	return timeOf(a) - timeOf(b) || a.id - b.id;
}

// Index of the first message in `list` that doesn't come before `message`
function lowerBound(list: ClientMessage[], message: ClientMessage): number {
	let lo = 0;
	let hi = list.length;

	while (lo < hi) {
		const mid = (lo + hi) >>> 1;

		if (compare(list[mid], message) < 0) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}

	return lo;
}

// Index of the first message in `list` that comes after `message`
function upperBound(list: ClientMessage[], message: ClientMessage): number {
	let lo = 0;
	let hi = list.length;

	while (lo < hi) {
		const mid = (lo + hi) >>> 1;

		if (compare(list[mid], message) <= 0) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}

	return lo;
}

/**
 * Adds a batch of search results to those shown, oldest first. Batches
 * arrive in the order they were stored, which isn't quite time order (a
 * bouncer's playback is stored after newer messages), so every result is
 * put in its place by time. A result already shown isn't added twice.
 *
 * Returns a new list, or `shown` itself when nothing was added. Only the
 * part of `shown` the batch falls within is walked: a page of older results
 * goes in front of the rest in one copy.
 */
export default function mergeSearchResults(
	shown: ClientMessage[],
	batch: ClientMessage[]
): ClientMessage[] {
	if (!batch.length) {
		return shown;
	}

	const sorted = batch.slice().sort(compare);
	const start = lowerBound(shown, sorted[0]);
	const end = upperBound(shown, sorted[sorted.length - 1]);
	const middle: ClientMessage[] = [];
	let added = 0;
	let i = start;

	for (const message of sorted) {
		while (i < end && compare(shown[i], message) < 0) {
			middle.push(shown[i++]);
		}

		const last = middle[middle.length - 1];

		// Same time and id: shown already, or twice in the batch
		if (
			(i < end && compare(shown[i], message) === 0) ||
			(last && compare(last, message) === 0)
		) {
			continue;
		}

		middle.push(message);
		added++;
	}

	if (!added) {
		return shown;
	}

	while (i < end) {
		middle.push(shown[i++]);
	}

	return shown.slice(0, start).concat(middle, shown.slice(end));
}
