<template>
	<template v-for="reg in registrations" :key="reg.id">
		<component :is="reg.component" v-bind="props" />
	</template>
</template>

<script lang="ts">
import {computed, defineComponent, onErrorCaptured, PropType} from "vue";
import {removeRegistration, slots, type SlotName} from "../js/themeModules";

/** Where theme client modules' components go (see js/themeModules.ts). */
export default defineComponent({
	name: "ThemeSlot",
	props: {
		name: {type: String as PropType<SlotName>, required: true},
		props: {type: Object as PropType<Record<string, unknown>>, default: () => ({})},
	},
	setup(p) {
		const registrations = computed(() => slots.get(p.name) || []);

		// A component that throws is taken out, the rest of the page carries on
		onErrorCaptured((err, instance) => {
			const reg = registrations.value.find((r) => instance?.$.type === r.component);
			// eslint-disable-next-line no-console
			console.error(`Theme slot ${p.name}: a component failed and was removed`, err);

			if (reg) {
				removeRegistration(p.name, reg.id);
			}

			return false;
		});

		return {registrations};
	},
});
</script>
