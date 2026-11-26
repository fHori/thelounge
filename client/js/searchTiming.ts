// How long searches took as the browser saw them, for the diagnostics page.
// Kept in memory only, and only their timing: never the term.
import {nextTick} from "vue";

export type BrowserSearch = {
	at: number;
	// From sending the search until the first results arrived, null if none did
	firstMs: number | null;
	// From sending the search until the page was done
	waitMs: number;
	// From the page being done until it was on screen
	renderMs: number;
	// Results shown in all
	results: number;
	// Older results ("Show older messages") rather than a new search
	more: boolean;
};

const logSize = 10;
export const browserSearches: BrowserSearch[] = [];
let sentAt: number | null = null;
let firstAt: number | null = null;

export function searchSent() {
	sentAt = performance.now();
	firstAt = null;
}

export function searchFirstResults() {
	firstAt ??= performance.now();
}

/**
 * Called once the page that was asked for last is done.
 */
export function searchAnswered(results: number, more: boolean) {
	if (sentAt === null) {
		return;
	}

	const answered = performance.now();
	const waitMs = answered - sentAt;
	const firstMs = firstAt === null ? null : firstAt - sentAt;
	sentAt = null;

	// Rendered after Vue's update, painted on the frame after that
	void nextTick(() =>
		requestAnimationFrame(() =>
			setTimeout(() => {
				browserSearches.unshift({
					at: Date.now(),
					firstMs,
					waitMs,
					renderMs: performance.now() - answered,
					results,
					more,
				});
				browserSearches.length = Math.min(browserSearches.length, logSize);
			}, 0)
		)
	);
}
