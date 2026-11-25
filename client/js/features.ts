import {computed} from "vue";
import {store} from "./store";
import {
	featureEnabled,
	parseFeatureValues,
	type FeatureName,
	type FeatureValues,
} from "../../shared/features";

/**
 * Whether an optional feature is on (see shared/features.ts): the user's choice,
 * else the selected theme's default, else the built-in one. Reactive.
 */

const userValues = computed(() => parseFeatureValues(store.state.settings.features));

const themeValues = computed<FeatureValues>(
	() =>
		store.state.serverConfiguration?.themes.find((t) => t.name === store.state.settings.theme)
			?.features || {}
);

export function feature(name: FeatureName): boolean {
	return featureEnabled(name, userValues.value, themeValues.value);
}

/** What the theme (or the built-in default) says, ignoring the user's choice. */
export function featureDefault(name: FeatureName): boolean {
	return featureEnabled(name, {}, themeValues.value);
}

export function userFeatureChoice(name: FeatureName): boolean | undefined {
	return userValues.value[name];
}

/** Saves the user's choice; null goes back to the theme's default. */
export function setFeature(name: FeatureName, enabled: boolean | null) {
	const next = {...userValues.value};

	if (enabled === null || enabled === featureDefault(name)) {
		delete next[name];
	} else {
		next[name] = enabled;
	}

	void store.dispatch("settings/update", {
		name: "features",
		value: Object.keys(next).length ? JSON.stringify(next) : "",
		sync: true,
	});
}
