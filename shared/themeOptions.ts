/**
 * Theme options: settings a theme declares in its package.json and core renders,
 * saves, syncs and applies, so CSS-only themes can have options too.
 *
 *   "thelounge": {
 *     "type": "theme",
 *     "options": {
 *       "messageDisplay": {
 *         "type": "select", "label": "Message display", "default": "compact",
 *         "choices": {"compact": "Compact", "cozy": "Cozy"},
 *         "css": {"cozy": "cozy.css"}
 *       },
 *       "accent": {"type": "color", "label": "Accent colour", "default": "#5865f2", "cssVar": "--accent"}
 *     }
 *   }
 *
 * For the selected theme, the client sets `data-theme-<kebab-key>="<value>"` on
 * <html>, sets `cssVar` for color and range options, and loads the stylesheet
 * `css` maps the current value to (`"true"` for booleans).
 *
 * All values are saved in one setting, `themeOptions`: a JSON string
 * `{"<theme name>": {"<key>": value}}` holding only values that differ from the
 * default. Values of other themes are kept, so switching back restores them.
 */

export type ThemeOptionValue = string | number | boolean;

type ThemeOptionBase = {
	label: string;
	description?: string;
	// Value (or "true" for booleans) → stylesheet among the package's files
	css?: Record<string, string>;
};

export type ThemeOption = ThemeOptionBase &
	(
		| {type: "boolean"; default: boolean}
		| {type: "select"; default: string; choices: Record<string, string>}
		| {type: "color"; default: string; cssVar?: string}
		| {
				type: "range";
				default: number;
				min: number;
				max: number;
				step?: number;
				unit?: string;
				cssVar?: string;
		  }
	);

export type ThemeOptions = Record<string, ThemeOption>;
export type ThemeOptionValues = Record<string, ThemeOptionValue>;

export const themeOptionLimits = {
	options: 32,
	choices: 32,
	label: 80,
	description: 300,
	// The whole themeOptions setting, which is sent to every client of the user
	storedLength: 16 * 1024,
};

export const themeOptionKeyRegex = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
const colorRegex = /^#[0-9a-f]{6}$/i;
const cssVarRegex = /^--[a-zA-Z0-9-]{1,64}$/;
const unitRegex = /^(px|em|rem|%|vh|vw|ms|s|deg)$/;
// Root-level file names only: the package route serves no sub-folders
const cssFileRegex = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}\.css$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const shortString = (v: unknown, max: number): v is string =>
	typeof v === "string" && v.length > 0 && v.length <= max;

/**
 * Validates a theme's declared options. Invalid options are left out, with the
 * reason in `errors`. `files` are the package's public files: stylesheets an
 * option maps to must be among them, or the server wouldn't serve them.
 */
export function parseThemeOptions(
	raw: unknown,
	files: string[] = []
): {options: ThemeOptions; errors: string[]} {
	const options: ThemeOptions = {};
	const errors: string[] = [];

	if (raw === undefined) {
		return {options, errors};
	}

	if (!isPlainObject(raw)) {
		return {options, errors: ["options must be an object"]};
	}

	for (const [key, def] of Object.entries(raw)) {
		if (Object.keys(options).length >= themeOptionLimits.options) {
			errors.push(`more than ${themeOptionLimits.options} options, the rest are ignored`);
			break;
		}

		const error = (why: string) => errors.push(`option "${key}": ${why}`);

		if (!themeOptionKeyRegex.test(key)) {
			error("key must be letters and digits, starting with a letter, at most 32");
			continue;
		}

		if (!isPlainObject(def)) {
			error("must be an object");
			continue;
		}

		if (!shortString(def.label, themeOptionLimits.label)) {
			error(`label is required, at most ${themeOptionLimits.label} characters`);
			continue;
		}

		if (
			def.description !== undefined &&
			!shortString(def.description, themeOptionLimits.description)
		) {
			error(`description must be at most ${themeOptionLimits.description} characters`);
			continue;
		}

		const base: ThemeOptionBase = {label: def.label};

		if (typeof def.description === "string") {
			base.description = def.description;
		}

		let option: ThemeOption;

		switch (def.type) {
			case "boolean":
				if (typeof def.default !== "boolean") {
					error("default must be true or false");
					continue;
				}

				option = {...base, type: "boolean", default: def.default};
				break;

			case "select": {
				const choices = isPlainObject(def.choices) ? Object.entries(def.choices) : [];

				if (
					choices.length === 0 ||
					choices.length > themeOptionLimits.choices ||
					!choices.every(
						([value, label]) =>
							shortString(value, 64) && shortString(label, themeOptionLimits.label)
					)
				) {
					error(`choices must map 1 to ${themeOptionLimits.choices} values to labels`);
					continue;
				}

				if (typeof def.default !== "string" || !choices.some(([v]) => v === def.default)) {
					error("default must be one of the choices");
					continue;
				}

				option = {
					...base,
					type: "select",
					default: def.default,
					choices: Object.fromEntries(choices) as Record<string, string>,
				};
				break;
			}

			case "color":
				if (typeof def.default !== "string" || !colorRegex.test(def.default)) {
					error("default must be a #rrggbb colour");
					continue;
				}

				option = {...base, type: "color", default: def.default.toLowerCase()};
				break;

			case "range": {
				const {min, max, step = 1} = def;

				if (
					typeof min !== "number" ||
					typeof max !== "number" ||
					typeof step !== "number" ||
					!Number.isFinite(min) ||
					!Number.isFinite(max) ||
					!(step > 0) ||
					min >= max
				) {
					error("needs numbers min < max and a positive step");
					continue;
				}

				if (typeof def.default !== "number" || def.default < min || def.default > max) {
					error("default must be a number between min and max");
					continue;
				}

				if (
					def.unit !== undefined &&
					!(typeof def.unit === "string" && unitRegex.test(def.unit))
				) {
					error("unit must be a CSS unit such as px, em, rem or %");
					continue;
				}

				option = {...base, type: "range", default: def.default, min, max, step};

				if (typeof def.unit === "string") {
					option.unit = def.unit;
				}

				break;
			}

			default:
				error("type must be boolean, select, color or range");
				continue;
		}

		if (def.cssVar !== undefined) {
			if (option.type !== "color" && option.type !== "range") {
				error("cssVar is only for color and range options");
				continue;
			}

			if (typeof def.cssVar !== "string" || !cssVarRegex.test(def.cssVar)) {
				error("cssVar must be a custom property name starting with --");
				continue;
			}

			option.cssVar = def.cssVar;
		}

		if (def.css !== undefined) {
			if (option.type !== "boolean" && option.type !== "select") {
				error("css is only for boolean and select options");
				continue;
			}

			const css = isPlainObject(def.css) ? Object.entries(def.css) : [];
			const values =
				option.type === "boolean" ? ["true", "false"] : Object.keys(option.choices);
			const bad = css.find(
				([value, file]) =>
					!values.includes(value) ||
					typeof file !== "string" ||
					!cssFileRegex.test(file) ||
					!files.includes(file)
			);

			if (css.length === 0 || bad) {
				error(
					`css must map option values to .css files listed in the package's "files"${
						bad ? ` ("${bad[0]}" doesn't)` : ""
					}`
				);
				continue;
			}

			option.css = Object.fromEntries(css) as Record<string, string>;
		}

		options[key] = option;
	}

	return {options, errors};
}

/** Whether `value` is allowed for `option`. */
export function isValidThemeOptionValue(option: ThemeOption, value: unknown): boolean {
	switch (option.type) {
		case "boolean":
			return typeof value === "boolean";
		case "select":
			return typeof value === "string" && Object.hasOwn(option.choices, value);
		case "color":
			return typeof value === "string" && colorRegex.test(value);
		case "range":
			return (
				typeof value === "number" &&
				Number.isFinite(value) &&
				value >= option.min &&
				value <= option.max
			);
	}
}

/** Every option's value: the stored one when valid, else the default. */
export function resolveThemeOptionValues(
	options: ThemeOptions,
	stored: unknown
): ThemeOptionValues {
	const values: ThemeOptionValues = {};
	const saved = isPlainObject(stored) ? stored : {};

	for (const [key, option] of Object.entries(options)) {
		values[key] = isValidThemeOptionValue(option, saved[key])
			? (saved[key] as ThemeOptionValue)
			: option.default;
	}

	return values;
}

/** Parses the themeOptions setting; anything malformed reads as empty. */
export function parseThemeOptionsSetting(
	setting: unknown
): Record<string, Record<string, unknown>> {
	if (typeof setting !== "string" || setting === "") {
		return {};
	}

	try {
		const parsed: unknown = JSON.parse(setting);

		if (!isPlainObject(parsed)) {
			return {};
		}

		const result: Record<string, Record<string, unknown>> = {};

		for (const [theme, values] of Object.entries(parsed)) {
			if (isPlainObject(values)) {
				result[theme] = values;
			}
		}

		return result;
	} catch {
		return {};
	}
}

/**
 * Cleans a themeOptions setting before it is saved: drops values that are
 * invalid or equal to the default for themes `schemaFor` knows, keeps primitive
 * values of themes it doesn't (uninstalled for now), and drops empty themes.
 * Returns null when the setting is too big or not a JSON object.
 */
export function sanitizeThemeOptionsSetting(
	setting: unknown,
	schemaFor: (theme: string) => ThemeOptions | undefined
): string | null {
	if (setting === "") {
		return "";
	}

	if (typeof setting !== "string" || setting.length > themeOptionLimits.storedLength) {
		return null;
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(setting);
	} catch {
		return null;
	}

	if (!isPlainObject(parsed)) {
		return null;
	}

	const result: Record<string, ThemeOptionValues> = {};

	for (const [theme, values] of Object.entries(parsed)) {
		if (!isPlainObject(values) || theme.length > 214) {
			continue;
		}

		const schema = schemaFor(theme);
		const kept: ThemeOptionValues = {};

		for (const [key, value] of Object.entries(values)) {
			if (schema) {
				const option = Object.hasOwn(schema, key) ? schema[key] : undefined;

				if (option && isValidThemeOptionValue(option, value) && value !== option.default) {
					kept[key] = value as ThemeOptionValue;
				}
			} else if (
				themeOptionKeyRegex.test(key) &&
				(typeof value === "string" ||
					typeof value === "number" ||
					typeof value === "boolean")
			) {
				kept[key] = value;
			}
		}

		if (Object.keys(kept).length > 0) {
			result[theme] = kept;
		}
	}

	return Object.keys(result).length > 0 ? JSON.stringify(result) : "";
}

/** messageDisplay → message-display, for the data attribute. */
export function themeOptionAttribute(key: string): string {
	return "data-theme-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}
