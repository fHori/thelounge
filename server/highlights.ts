import escapeRegExp from "lodash/escapeRegExp.js";

// Turns a comma separated list of words into a case insensitive regex that
// matches any of them as a whole word. Returns null when the list is empty.
export function compileHighlightRegex(customHighlightString: unknown): RegExp | null {
	if (typeof customHighlightString !== "string") {
		return null;
	}

	// Ensure we don't have empty strings in the list of highlights
	const highlightsTokens = customHighlightString
		.split(",")
		.map((highlight) => escapeRegExp(highlight.trim()))
		.filter((highlight) => highlight.length > 0);

	if (highlightsTokens.length === 0) {
		return null;
	}

	return new RegExp(
		`(?:^|[ .,+!?|/:<>(){}'"@&~-])(?:${highlightsTokens.join("|")})(?:$|[ .,+!?|/:<>(){}'"-])`,
		"i"
	);
}
