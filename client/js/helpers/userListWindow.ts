// Which rows of a user list group to draw: those in view plus some margin,
// so scrolling a little doesn't need new rows. Rows all have the same height.

export type RowRange = readonly [start: number, end: number];

// Rows drawn above and below the view
export const OVERSCAN_ROWS = 30;

export function rowsInView(
	count: number,
	// Where the group's first row is and where the view is, in the same coordinates
	rowsTop: number,
	viewTop: number,
	viewBottom: number,
	rowHeight: number
): RowRange {
	if (count === 0 || rowHeight <= 0 || viewBottom <= viewTop) {
		return [0, 0];
	}

	const start = Math.floor((viewTop - rowsTop) / rowHeight);
	const end = Math.ceil((viewBottom - rowsTop) / rowHeight);

	return [clamp(start, count), clamp(end, count)];
}

/**
 * The rows to draw for a group: `current` while it still has every row in
 * view, otherwise the rows in view with OVERSCAN_ROWS on either side.
 */
export function rowsToDraw(
	count: number,
	inView: RowRange,
	current: RowRange | undefined,
	overscan = OVERSCAN_ROWS
): RowRange {
	const [start, end] = inView;

	if (start >= end) {
		// Nothing of the group is in view: keep drawing what was drawn, as
		// long as it's still valid, so scrolling past a group doesn't
		// redraw it.
		if (current && current[1] <= count) {
			return current;
		}

		return [0, 0];
	}

	if (current && current[0] <= start && current[1] >= end && current[1] <= count) {
		return current;
	}

	return [clamp(start - overscan, count), clamp(end + overscan, count)];
}

function clamp(n: number, count: number) {
	return Math.max(0, Math.min(n, count));
}
