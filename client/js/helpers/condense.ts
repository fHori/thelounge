/**
 * Groups runs of status messages (joins, parts, ...) for the message list
 * when they are shown condensed.
 */
import {condensedTypes} from "../../../shared/irc";
import type {ClientMessage} from "../types";

export type CondensedMessageContainer = {
	type: "condensed";
	time: Date;
	messages: ClientMessage[];
	id?: number;
};

export type ListEntry = ClientMessage | CondensedMessageContainer;

// Messages of your own, highlights and anything that isn't a status
// message are never grouped and end the group before them
const breaksGroup = (message: ClientMessage) =>
	message.self || message.highlight || !condensedTypes.has(message.type || "");

const container = (messages: ClientMessage[]): CondensedMessageContainer => ({
	type: "condensed",
	time: messages[0].time,
	messages,
	id: messages[messages.length - 1].id,
});

/**
 * The entries for `messages`, all at once. A group ends after the first
 * unread message, and a group of one message is just that message.
 */
export function condenseMessages(messages: ClientMessage[], firstUnread: number): ListEntry[] {
	let lastCondensedContainer: CondensedMessageContainer | null = null;
	const condensed: ListEntry[] = [];

	for (const message of messages) {
		if (breaksGroup(message)) {
			lastCondensedContainer = null;
			condensed.push(message);
			continue;
		}

		if (!lastCondensedContainer) {
			lastCondensedContainer = {
				time: message.time,
				type: "condensed",
				messages: [],
			};
			condensed.push(lastCondensedContainer);
		}

		lastCondensedContainer.messages.push(message);
		lastCondensedContainer.id = message.id;

		if (message.id === firstUnread) {
			lastCondensedContainer = null;
		}
	}

	return condensed.map((message) => {
		if (message.type === "condensed" && message.messages.length === 1) {
			return message.messages[0];
		}

		return message;
	});
}

/**
 * Gives the same entries as condenseMessages, but keeps them between calls:
 * when messages were only added at the end and dropped from the front (what
 * a busy channel does), only the entries at the edges change. Anything else
 * (older history added in front, the list replaced, `firstUnread` moving)
 * builds the entries again.
 *
 * Entries that didn't change keep their identity, so the components showing
 * them aren't updated. A group that grows is a new object with a new
 * messages array.
 */
export class MessageCondenser {
	// The messages the entries are made of, as of the last update
	private source: ClientMessage[] = [];
	// Index in `source` of the first message of each entry, plus `base`
	private starts: number[] = [];
	private base = 0;
	private entries: ListEntry[] = [];
	private firstUnread = NaN;

	// Messages of the group at the end that new messages may still join,
	// and whether that array was made during this update (so it may be
	// changed in place: nothing outside has seen it yet)
	private open: ClientMessage[] | null = null;
	private openOwned = false;

	update(messages: readonly ClientMessage[], firstUnread: number): ListEntry[] {
		this.openOwned = false;

		if (firstUnread !== this.firstUnread || !this.updateEdges(messages)) {
			this.rebuild(messages, firstUnread);
		}

		return this.entries.slice();
	}

	private rebuild(messages: readonly ClientMessage[], firstUnread: number) {
		this.source = [];
		this.starts = [];
		this.base = 0;
		this.entries = [];
		this.firstUnread = firstUnread;
		this.open = null;

		for (const message of messages) {
			this.append(message);
		}
	}

	// Brings the entries up to date if `messages` is what they were made of
	// with some messages dropped from the front and some added at the end
	private updateEdges(messages: readonly ClientMessage[]): boolean {
		const source = this.source;

		if (source.length === 0 || messages.length === 0) {
			return false;
		}

		const dropped = messages[0] === source[0] ? 0 : source.indexOf(messages[0], 1);

		if (dropped < 0) {
			return false;
		}

		const kept = source.length - dropped;

		if (messages.length < kept || messages[kept - 1] !== source[source.length - 1]) {
			return false;
		}

		if (dropped > 0) {
			this.dropFront(dropped);
		}

		for (let i = kept; i < messages.length; i++) {
			this.append(messages[i]);
		}

		return true;
	}

	private append(message: ClientMessage) {
		const index = this.base + this.source.length;
		this.source.push(message);

		if (breaksGroup(message)) {
			this.open = null;
			this.entries.push(message);
			this.starts.push(index);
			return;
		}

		if (!this.open) {
			// A group of one is the message itself
			this.open = [message];
			this.openOwned = true;
			this.entries.push(message);
			this.starts.push(index);
		} else {
			if (!this.openOwned) {
				this.open = this.open.slice();
				this.openOwned = true;
			}

			this.open.push(message);
			const last = this.entries.length - 1;
			const entry = this.entries[last];

			if (entry.type === "condensed" && entry.messages === this.open) {
				entry.id = message.id;
			} else {
				this.entries[last] = container(this.open);
			}
		}

		if (message.id === this.firstUnread) {
			this.open = null;
		}
	}

	private dropFront(count: number) {
		const newBase = this.base + count;
		this.source.splice(0, count);

		// Entries that start before the new first message
		let gone = 0;

		while (gone < this.starts.length && this.starts[gone] < newBase) {
			gone++;
		}

		// The last of them may go on past it: a group, of which the rest stays
		const end = gone < this.starts.length ? this.starts[gone] : newBase + this.source.length;

		if (end > newBase) {
			const entry = this.entries[gone - 1] as CondensedMessageContainer;
			const rest = entry.messages.slice(entry.messages.length - (end - newBase));
			const isOpen = this.open === entry.messages;

			gone--;
			this.entries[gone] = rest.length === 1 ? rest[0] : container(rest);
			this.starts[gone] = newBase;

			if (isOpen) {
				this.open = rest;
				this.openOwned = true;
			}
		}

		this.entries.splice(0, gone);
		this.starts.splice(0, gone);
		this.base = newBase;
	}
}
