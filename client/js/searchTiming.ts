// How long searches took as the browser saw them, for the diagnostics page.
// Kept in memory only, and only their timing: never the term.
import {nextTick} from "vue";

export type BrowserSearch = {
	at: number;
	// From sending the search until the answer arrived
	waitMs: number;
	// From the answer until the results were on screen
	renderMs: number;
	results: number;
	// 0 for a new search, more when loading older results
	offset: number;
};

const logSize = 10;
export const browserSearches: BrowserSearch[] = [];
let sentAt: number | null = null;

export function searchSent() {
	sentAt = performance.now();
}

/**
 * Called once the answer to the last search sent is in the store.
 */
export function searchAnswered(results: number, offset: number) {
	if (sentAt === null) {
		return;
	}

	const answered = performance.now();
	const waitMs = answered - sentAt;
	sentAt = null;

	// Rendered after Vue's update, painted on the frame after that
	void nextTick(() =>
		requestAnimationFrame(() =>
			setTimeout(() => {
				browserSearches.unshift({
					at: Date.now(),
					waitMs,
					renderMs: performance.now() - answered,
					results,
					offset,
				});
				browserSearches.length = Math.min(browserSearches.length, logSize);
			}, 0)
		)
	);
}
