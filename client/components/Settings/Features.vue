<template>
	<div class="settings-features">
		<h2>Features</h2>
		<div v-for="item in items" :key="item.name" class="settings-feature">
			<label class="opt">
				<input
					type="checkbox"
					:checked="item.enabled"
					@change.stop="set(item.name, ($event.target as HTMLInputElement).checked)"
				/>
				{{ item.label }}
				<span v-if="item.followsDefault && item.themeChanged" class="settings-feature-note"
					>(on with this theme)</span
				>
				<button
					v-if="!item.followsDefault"
					type="button"
					class="settings-feature-reset"
					@click="set(item.name, null)"
				>
					Use default
				</button>
			</label>
			<p v-if="item.description" class="help settings-feature-description">
				{{ item.description }}
			</p>
		</div>
	</div>
</template>

<style>
.settings-features .settings-feature {
	margin-bottom: 8px;
}

.settings-features .settings-feature-description {
	margin: 0 0 0 1.5rem;
	opacity: 0.7;
}

.settings-features .settings-feature-note {
	margin-left: 6px;
	opacity: 0.7;
}

.settings-features .settings-feature-reset {
	margin-left: 8px;
	padding: 0;
	border: 0;
	background: none;
	color: var(--link-color);
	cursor: pointer;
}
</style>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {useStore} from "../../js/store";
import {feature, featureDefault, setFeature, userFeatureChoice} from "../../js/features";
import {featureNames, features, type FeatureName} from "../../../shared/features";

export default defineComponent({
	name: "FeatureSettings",
	setup() {
		const store = useStore();

		const items = computed(() => {
			// Read so the list updates with the settings and the theme
			void store.state.settings.features;
			void store.state.settings.theme;

			return featureNames.map((name) => ({
				name,
				label: features[name].label,
				description: "description" in features[name] ? features[name].description : "",
				enabled: feature(name),
				followsDefault: userFeatureChoice(name) === undefined,
				themeChanged: featureDefault(name) !== features[name].default,
			}));
		});

		const set = (name: FeatureName, enabled: boolean | null) => setFeature(name, enabled);

		return {items, set};
	},
});
</script>
