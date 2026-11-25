/**
 * Optional features. Each has a built-in default; a theme can change the default
 * for its users (package.json "thelounge": {"features": {"quickSwitcher": true}}),
 * and the user's own choice in Settings always wins. Users' choices are saved in
 * one setting, `features`: a JSON string {"<feature>": true | false}.
 */

export const features = {
	emojiPicker: {
		label: "Emoji picker in the message box",
		default: true,
	},
	gifPicker: {
		label: "GIF picker in the message box",
		description: "Shown when this Lounge has GIF search set up.",
		default: true,
	},
	quickSwitcher: {
		label: "Quick switcher",
		description:
			"Ctrl+K and the Jump to box open a dialog to go to any channel, conversation or network, or start a conversation. Ctrl+K then no longer inserts a colour code.",
		default: false,
	},
	discover: {
		label: "Discover",
		description: "Find channels on all your networks at once.",
		default: false,
	},
	conversationDetails: {
		label: "Conversation details",
		description:
			"Clicking a channel or conversation's name shows its members, media, links and files.",
		default: false,
	},
	profilePanel: {
		label: "Profile next to conversations",
		description: "Shows who you're talking to next to a private conversation.",
		default: false,
	},
	homeDms: {
		label: "All conversations in one place",
		description: "Private conversations of every network in one list.",
		default: false,
	},
} as const;

export type FeatureName = keyof typeof features;
export type FeatureValues = Partial<Record<FeatureName, boolean>>;

export const featureNames = Object.keys(features) as FeatureName[];

export const isFeatureName = (name: unknown): name is FeatureName =>
	typeof name === "string" && Object.hasOwn(features, name);

/** Keeps only known features with boolean values. */
export function parseFeatureValues(raw: unknown): FeatureValues {
	let value = raw;

	if (typeof value === "string") {
		try {
			value = value ? JSON.parse(value) : {};
		} catch {
			return {};
		}
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}

	const result: FeatureValues = {};

	for (const [name, enabled] of Object.entries(value)) {
		if (isFeatureName(name) && typeof enabled === "boolean") {
			result[name] = enabled;
		}
	}

	return result;
}

/** The user's choice, else the theme's default, else the built-in one. */
export function featureEnabled(
	name: FeatureName,
	user: FeatureValues,
	theme: FeatureValues = {}
): boolean {
	return user[name] ?? theme[name] ?? features[name].default;
}
