// Unsent input text per channel, kept in localStorage so it survives reloads.
// Keyed by network uuid and channel name: channel ids change when the server restarts.

import {ChanType} from "../../shared/types/chan";

export const DRAFT_PREFIX = "thelounge.draft.";

type DraftChan = {name: string; type: ChanType};
type DraftNetwork = {uuid: string; channels: DraftChan[]};
type Backend = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function draftKey(networkUuid: string, chan: DraftChan) {
	// The lobby is named after the network, which can be renamed
	const name = chan.type === ChanType.LOBBY ? "" : chan.name.toLowerCase();
	return `${DRAFT_PREFIX}${networkUuid}.${name}`;
}

export function createDraftStore(getBackend: () => Backend, delay = 500) {
	const pending = new Map<string, {timer: ReturnType<typeof setTimeout>; text: string}>();

	// Storage can be blocked or full, drafts are best effort
	const attempt = <T>(fn: (backend: Backend) => T, fallback: T): T => {
		try {
			return fn(getBackend());
		} catch {
			return fallback;
		}
	};

	const write = (key: string, text: string) =>
		attempt((b) => {
			if (!text) {
				b.removeItem(key);
			} else if (b.getItem(key) !== text) {
				b.setItem(key, text);
			}
		}, undefined);

	const cancel = (key: string) => {
		const entry = pending.get(key);

		if (entry) {
			clearTimeout(entry.timer);
			pending.delete(key);
		}
	};

	return {
		load(networkUuid: string, chan: DraftChan): string {
			const key = draftKey(networkUuid, chan);
			const entry = pending.get(key);

			if (entry) {
				return entry.text;
			}

			return attempt((b) => b.getItem(key), null) || "";
		},

		// Text is written after typing pauses; clearing is written at once
		// so a sent message does not come back after a reload
		save(networkUuid: string, chan: DraftChan, text: string) {
			const key = draftKey(networkUuid, chan);
			cancel(key);

			if (!text) {
				write(key, "");
				return;
			}

			const timer = setTimeout(() => {
				pending.delete(key);
				write(key, text);
			}, delay);
			pending.set(key, {timer, text});
		},

		remove(networkUuid: string, chan: DraftChan) {
			const key = draftKey(networkUuid, chan);
			cancel(key);
			write(key, "");
		},

		flush() {
			for (const [key, entry] of pending) {
				clearTimeout(entry.timer);
				write(key, entry.text);
			}

			pending.clear();
		},

		// Drop drafts of channels and networks that are gone
		prune(networks: DraftNetwork[]) {
			const keep = new Set<string>();

			for (const network of networks) {
				for (const chan of network.channels) {
					keep.add(draftKey(network.uuid, chan));
				}
			}

			for (const key of pending.keys()) {
				if (!keep.has(key)) {
					cancel(key);
				}
			}

			attempt((b) => {
				const stale: string[] = [];

				for (let i = 0; i < b.length; i++) {
					const key = b.key(i);

					if (key && key.startsWith(DRAFT_PREFIX) && !keep.has(key)) {
						stale.push(key);
					}
				}

				stale.forEach((key) => b.removeItem(key));
			}, undefined);
		},
	};
}

const drafts = createDraftStore(() => window.localStorage);

if (typeof window !== "undefined") {
	window.addEventListener("pagehide", () => drafts.flush());
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") {
			drafts.flush();
		}
	});
}

export default drafts;
