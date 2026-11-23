<template>
	<div :aria-label="localeDate" class="date-marker-container tooltipped tooltipped-s">
		<div class="date-marker">
			<span :aria-label="friendlyDate" class="date-marker-text" />
		</div>
	</div>
</template>

<script lang="ts">
import dayjs from "dayjs";
import calendar from "dayjs/plugin/calendar";
import {computed, defineComponent, onBeforeUnmount, onMounted, PropType, ref} from "vue";
import eventbus from "../js/eventbus";
import type {ClientMessage} from "../js/types";

dayjs.extend(calendar);

export default defineComponent({
	name: "DateMarker",
	props: {
		message: {
			type: Object as PropType<ClientMessage>,
			required: true,
		},
		isFocused: Boolean,
	},
	setup(props) {
		const localeDate = computed(() => dayjs(props.message.time).format("D MMMM YYYY"));

		const hoursPassed = () => {
			return (Date.now() - Date.parse(props.message.time.toString())) / 3600000;
		};

		// Bumped on every day change so the label re-renders ("Today" becomes "Yesterday").
		const dayTick = ref(0);

		const dayChange = () => {
			dayTick.value++;

			if (hoursPassed() >= 48) {
				eventbus.off("daychange", dayChange);
			}
		};

		const friendlyDate = computed(() => {
			void dayTick.value;

			// A server clock a few seconds ahead of the browser's can stamp a message
			// "tomorrow" just before midnight. Messages can't come from the future, so
			// read any such timestamp as now.
			const time = Math.min(Date.parse(props.message.time.toString()), Date.now());

			return dayjs(time).calendar(null, {
				sameDay: "[Today]",
				lastDay: "[Yesterday]",
				lastWeek: "D MMMM YYYY",
				sameElse: "D MMMM YYYY",
			});
		});

		onMounted(() => {
			if (hoursPassed() < 48) {
				eventbus.on("daychange", dayChange);
			}
		});

		onBeforeUnmount(() => {
			eventbus.off("daychange", dayChange);
		});

		return {
			localeDate,
			friendlyDate,
		};
	},
});
</script>
