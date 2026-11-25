<template>
	<div v-if="theme" class="theme-options">
		<p v-if="theme.author || theme.repositoryUrl" class="theme-credits">
			<template v-if="theme.author">by {{ theme.author }}</template>
			<template v-if="theme.author && theme.repositoryUrl"> · </template>
			<a
				v-if="theme.repositoryUrl"
				:href="theme.repositoryUrl"
				target="_blank"
				rel="noopener noreferrer"
				>Source</a
			>
		</p>
		<p v-for="rec in missingRecommendations" :key="rec.name" class="theme-recommends">
			Goes well with <strong>{{ rec.name }}</strong><template v-if="rec.description"
				>: {{ rec.description }}</template
			>. Not installed on this Lounge; the server's admin can add it with
			<code>{{ rec.install || `thelounge install ${rec.name}` }}</code>
		</p>
		<template v-if="entries.length">
			<h2>Theme options</h2>
			<div v-for="[key, option] in entries" :key="key" class="theme-option">
				<label v-if="option.type === 'boolean'" class="opt">
					<input
						type="checkbox"
						:checked="values[key] === true"
						@change.stop="set(key, ($event.target as HTMLInputElement).checked)"
					/>
					{{ option.label }}
				</label>
				<template v-else>
					<label :for="`theme-option-${key}`" class="opt">{{ option.label }}</label>
					<select
						v-if="option.type === 'select'"
						:id="`theme-option-${key}`"
						class="input"
						:value="values[key]"
						@change.stop="set(key, ($event.target as HTMLSelectElement).value)"
					>
						<option
							v-for="(label, value) in option.choices"
							:key="value"
							:value="value"
						>
							{{ label }}
						</option>
					</select>
					<div v-else-if="option.type === 'color'" class="theme-option-row">
						<input
							:id="`theme-option-${key}`"
							type="color"
							:value="values[key]"
							@change.stop="set(key, ($event.target as HTMLInputElement).value)"
						/>
						<button
							v-if="values[key] !== option.default"
							type="button"
							class="btn btn-small"
							@click="set(key, option.default)"
						>
							Reset
						</button>
					</div>
					<div v-else-if="option.type === 'range'" class="theme-option-row">
						<input
							:id="`theme-option-${key}`"
							type="range"
							:min="option.min"
							:max="option.max"
							:step="option.step || 1"
							:value="values[key]"
							@change.stop="
								set(key, Number(($event.target as HTMLInputElement).value))
							"
						/>
						<span>{{ values[key] }}{{ option.unit || "" }}</span>
					</div>
				</template>
				<p v-if="option.description" class="help theme-option-description">
					{{ option.description }}
				</p>
			</div>
		</template>
	</div>
</template>

<style>
.theme-options .theme-credits {
	margin: 6px 0 0;
	opacity: 0.8;
}

.theme-options .theme-recommends {
	margin: 6px 0 0;
	opacity: 0.8;
}

.theme-options .theme-option {
	margin-bottom: 10px;
}

.theme-options .theme-option-row {
	display: flex;
	align-items: center;
	gap: 10px;
}

.theme-options .theme-option-description {
	margin: 2px 0 0;
	opacity: 0.7;
}
</style>

<script lang="ts">
import {computed, defineComponent} from "vue";
import {useStore} from "../../js/store";
import {selectedTheme, setThemeOption, themeOptionValues} from "../../js/themeOptions";
import type {ThemeOptionValue} from "../../../shared/themeOptions";

export default defineComponent({
	name: "ThemeOptions",
	setup() {
		const store = useStore();

		// Reading settings.theme and settings.themeOptions keeps these reactive
		const theme = computed(() => {
			void store.state.settings.theme;
			return selectedTheme(store);
		});
		const entries = computed(() => Object.entries(theme.value?.options || {}));
		// Packages the theme recommends that aren't installed here
		const missingRecommendations = computed(() =>
			(theme.value?.recommends || []).filter((r) => !r.installed)
		);
		const values = computed(() => {
			void store.state.settings.themeOptions;
			return theme.value ? themeOptionValues(store, theme.value) : {};
		});

		const set = (key: string, value: ThemeOptionValue) => setThemeOption(store, key, value);

		return {theme, entries, missingRecommendations, values, set};
	},
});
</script>
