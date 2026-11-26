/**
 * Where the message list puts its date and unread markers. The list renders a
 * window into all its entries, so these look at the full list: the first
 * rendered entry is not the first entry.
 */

type Entry = {id?: number; time: Date | string | number};

/**
 * Whether entry `index` of `entries` starts a new day. The very first entry
 * does.
 */
export function startsNewDay(entries: Entry[], index: number): boolean {
	const previous = entries[index - 1];

	if (!previous) {
		return true;
	}

	return dayOf(previous) !== dayOf(entries[index]);
}

// Each render asks this for every rendered entry, so the day of an entry is
// worked out once
const days = new WeakMap<Entry, number>();

function dayOf(entry: Entry): number {
	let day = days.get(entry);

	if (day === undefined) {
		const date = new Date(entry.time);
		day = date.getFullYear() * 10000 + date.getMonth() * 100 + date.getDate();
		days.set(entry, day);
	}

	return day;
}

/**
 * The index of the entry the unread marker goes in front of: the first one
 * newer than `firstUnread`, so the entry before it in the full list (if any)
 * is not. -1 when there is none.
 */
export function unreadMarkerIndex(entries: Entry[], firstUnread: number): number {
	return entries.findIndex((entry) => Number(entry.id) > firstUnread);
}
