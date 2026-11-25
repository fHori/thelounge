import type {TypedStore} from "./store";
import {
	parseThemeOptionsSetting,
	resolveThemeOptionValues,
	themeOptionAttribute,
	ThemeOptionValue,
	ThemeOptionValues,
} from "../../shared/themeOptions";
import type {ConfigTheme} from "../../shared/types/config";

/**
 * Applies the selected theme's options (see shared/themeOptions.ts): data
 * attributes on <html>, CSS variables, and option stylesheets right after the
 * theme's own. Whatever the previous theme or value set is removed first.
 */

const appliedAttributes = new Set<string>();
const appliedVars = new Set<string>();

export function selectedTheme(store: TypedStore): ConfigTheme | undefined {
	return store.state.serverConfiguration?.themes.find(
		(t) => t.name === store.state.settings.theme
	);
}

export function themeOptionValues(store: TypedStore, theme: ConfigTheme): ThemeOptionValues {
	const stored = parseThemeOptionsSetting(store.state.settings.themeOptions)[theme.name];
	return resolveThemeOptionValues(theme.options || {}, stored);
}

export function applyThemeOptions(store: TypedStore) {
	const root = document.documentElement;
	const theme = selectedTheme(store);
	const options = theme?.options || {};
	const values = theme ? themeOptionValues(store, theme) : {};

	const attributes = new Map<string, string>();
	const vars = new Map<string, string>();
	const stylesheets: string[] = [];

	for (const [key, option] of Object.entries(options)) {
		const value = values[key];
		attributes.set(themeOptionAttribute(key), String(value));

		if ((option.type === "color" || option.type === "range") && option.cssVar) {
			vars.set(
				option.cssVar,
				option.type === "range" ? `${value}${option.unit || ""}` : String(value)
			);
		}

		const file = option.css?.[String(value)];

		if (theme && file) {
			stylesheets.push(`packages/${theme.name}/${encodeURIComponent(file)}`);
		}
	}

	for (const name of appliedAttributes) {
		if (!attributes.has(name)) {
			root.removeAttribute(name);
		}
	}

	appliedAttributes.clear();

	for (const [name, value] of attributes) {
		root.setAttribute(name, value);
		appliedAttributes.add(name);
	}

	for (const name of appliedVars) {
		if (!vars.has(name)) {
			root.style.removeProperty(name);
		}
	}

	appliedVars.clear();

	for (const [name, value] of vars) {
		root.style.setProperty(name, value);
		appliedVars.add(name);
	}

	// Keep links that stay, so switching one option doesn't reload the others
	const existing = [...document.querySelectorAll<HTMLLinkElement>("link[data-theme-option]")];

	for (const link of existing) {
		if (!stylesheets.includes(link.getAttribute("href") || "")) {
			link.remove();
		}
	}

	let after: Element | null = document.getElementById("theme");

	for (const href of stylesheets) {
		let link = existing.find((l) => l.isConnected && l.getAttribute("href") === href);

		if (!link) {
			link = document.createElement("link");
			link.rel = "stylesheet";
			link.dataset.themeOption = "";
			link.setAttribute("href", href);
		}

		if (after) {
			after.after(link);
		} else {
			document.head.appendChild(link);
		}

		after = link;
	}
}

/** Saves one option of the selected theme, storing only non-default values. */
export function setThemeOption(store: TypedStore, key: string, value: ThemeOptionValue) {
	const theme = selectedTheme(store);
	const option = theme?.options?.[key];

	if (!theme || !option) {
		return;
	}

	const all = parseThemeOptionsSetting(store.state.settings.themeOptions);
	const mine = {...(all[theme.name] || {})};

	if (value === option.default) {
		delete mine[key];
	} else {
		mine[key] = value;
	}

	if (Object.keys(mine).length > 0) {
		all[theme.name] = mine;
	} else {
		delete all[theme.name];
	}

	void store.dispatch("settings/update", {
		name: "themeOptions",
		value: Object.keys(all).length > 0 ? JSON.stringify(all) : "",
		sync: true,
	});
}
