<template>
	<aside
		ref="userlist"
		class="userlist"
		:aria-label="'User list for ' + channel.name"
		@mouseleave="removeHoverUser"
	>
		<div class="count">
			<input
				ref="input"
				:value="userSearchInput"
				:placeholder="
					channel.users.length + ' user' + (channel.users.length === 1 ? '' : 's')
				"
				type="search"
				class="search"
				aria-label="Search among the user list"
				tabindex="-1"
				@input="setUserSearchInput"
				@keydown.up="navigateUserList($event, -1)"
				@keydown.down="navigateUserList($event, 1)"
				@keydown.page-up="navigateUserList($event, -10)"
				@keydown.page-down="navigateUserList($event, 10)"
				@keydown.enter="selectUser"
			/>
		</div>
		<div ref="names" class="names" @scroll.passive="scheduleMeasure">
			<!-- Only the rows in view are drawn, spacers stand in for the others:
			     drawing every user of a channel with thousands took long enough
			     to freeze switching to it -->
			<div v-for="(group, index) in shownGroups" :key="group.key" :class="group.classes">
				<div
					v-if="group.header !== null && group.count > 0"
					:class="['custom-group-header', 'group-header-' + getGroupSlug(group.header)]"
				>
					{{ group.header }}
				</div>
				<div :data-rows-of="index" :style="{height: group.before + 'px'}" />
				<template v-if="userSearchInput.length > 0">
					<!-- eslint-disable vue/no-v-text-v-html-on-component -->
					<Username
						v-for="user in group.users"
						:key="user.original.nick + '-search'"
						:on-hover="hoverUser"
						:active="user.original === activeUser"
						:user="user.original"
						v-html="user.string"
					/>
					<!-- eslint-enable -->
				</template>
				<template v-else>
					<Username
						v-for="user in group.users"
						:key="user.nick"
						:on-hover="hoverUser"
						:active="user === activeUser"
						:user="user"
					/>
				</template>
				<div :style="{height: group.after + 'px'}" />
			</div>
		</div>
	</aside>
</template>

<style lang="css">
.custom-group-header {
	background: var(--window-bg-color);
	color: var(--body-color-muted);
	display: flex;
	font-weight: 700;
	padding: 8px 14px 8px 10px;
	position: sticky;
	top: 0;

	&::before {
		font-weight: 900;
		font-family: "Font Awesome 7 Pro";
		display: var(--fa-display, inline-block);
		font-style: normal;
		font-variant: normal;
		text-rendering: auto;
		margin-right: 6px;
		align-self: center;
	}

	&::after {
		content: "";
		height: 1px;
		background: currentColor;
		margin: 0 0 0 10px;
		opacity: 0.5;
		flex-grow: 1;
		align-self: center;
	}
}
</style>

<script lang="ts">
import {filter as fuzzyFilter} from "fuzzy";
import {
	computed,
	defineComponent,
	nextTick,
	onMounted,
	onUnmounted,
	PropType,
	ref,
	shallowRef,
	watch,
} from "vue";
import type {UserInMessage} from "../../shared/types/msg";
import type {ClientChan, ClientUser} from "../js/types";
import Username from "./Username.vue";
import groupSlug from "../js/helpers/groupSlug";
import {useStore} from "../js/store";
import {OVERSCAN_ROWS, RowRange, rowsInView, rowsToDraw} from "../js/helpers/userListWindow";

const modes = {
	"~": "owner",
	"&": "admin",
	"!": "admin",
	"@": "op",
	"%": "half-op",
	"+": "voice",
	"": "normal",
};

export default defineComponent({
	name: "ChatUserList",
	components: {
		Username,
	},
	props: {
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	setup(props) {
		const store = useStore();
		const userSearchInput = ref("");
		const activeUser = ref<UserInMessage | null>();
		const userlist = ref<HTMLDivElement>();
		const names = ref<HTMLDivElement>();

		// Check if we have custom groups from SPGROUPS
		const hasCustomGroups = computed(() => {
			return (
				store.state.settings.enhancedUserListEnabled &&
				props.channel.groups &&
				props.channel.groups.length > 0
			);
		});

		const filteredUsers = computed(() => {
			if (!userSearchInput.value) {
				return;
			}

			return fuzzyFilter(userSearchInput.value, props.channel.users, {
				pre: "<b>",
				post: "</b>",
				extract: (u) => u.nick,
			});
		});

		// Get CSS-safe group name
		const getGroupSlug = (group: string) => groupSlug(group);

		const customGroupedUsers = computed(() => {
			// No prototype, so a group called e.g. "__proto__" is just a key
			const groups = Object.create(null) as Record<string, unknown[]>;

			if (hasCustomGroups.value) {
				// Members as sets: with thousands of users, searching each
				// group's array for every user took millions of comparisons.
				// Nicks compare case-insensitively, as on IRC.
				const members = (props.channel.groups ?? []).map(({name, users}) => ({
					name,
					nicks: new Set(users.map((nick) => nick.toLowerCase())),
				}));

				if (userSearchInput.value && filteredUsers.value) {
					const filtered = filteredUsers.value
						.filter((user) => user.original.nick)
						.map((user) => ({user, nick: user.original.nick.toLowerCase()}));

					for (const {name, nicks} of members) {
						groups[name] ??= [];

						for (const {user, nick} of filtered) {
							if (nicks.has(nick)) {
								groups[name].push(user);
							}
						}
					}
				} else {
					const users = props.channel.users.map((user) => ({
						user,
						nick: user.nick.toLowerCase(),
					}));

					for (const {name, nicks} of members) {
						groups[name] ??= [];

						for (const {user, nick} of users) {
							if (nicks.has(nick)) {
								groups[name].push(user);
							}
						}
					}
				}
			}

			return groups as {
				[group: string]: (ClientUser & {
					original: UserInMessage;
					string: string;
				})[];
			};
		});

		const standardGroupedUsers = computed(() => {
			const groups = {};

			if (!hasCustomGroups.value) {
				if (userSearchInput.value && filteredUsers.value) {
					const result = filteredUsers.value;

					for (const user of result) {
						const mode: string = user.original.modes[0] || "";
						groups[mode] ??= [];

						// Prepend user mode to search result
						user.string = mode + user.string;
						groups[mode].push(user);
					}
				} else {
					for (const user of props.channel.users) {
						const mode = user.modes[0] || "";

						groups[mode] ??= [];
						groups[mode].push(user);
					}
				}
			}

			return groups;
		});

		const groupedUsers = computed(() => {
			return hasCustomGroups.value ? customGroupedUsers.value : standardGroupedUsers.value;
		});

		// Height of one row, measured once a row is drawn. Until then a guess:
		// 14px text with a line height of 1.6.
		const rowHeight = ref(22.4);
		// Rows drawn of each group, by group key
		const drawn = shallowRef<Record<string, RowRange>>({});

		const groupEntries = computed(() =>
			Object.entries(groupedUsers.value as Record<string, unknown[]>)
		);

		const shownGroups = computed(() =>
			groupEntries.value.map(([name, users]) => {
				const key = hasCustomGroups.value ? "group-" + name : name;
				const count = users.length;
				// Before the first measurement, enough rows to fill the view
				const [start, end] = drawn.value[key] ?? [0, OVERSCAN_ROWS * 2];
				const first = Math.min(start, count);
				const last = Math.min(end, count);

				return {
					key,
					classes: hasCustomGroups.value
						? ["user-mode", "custom-group", "group-" + getGroupSlug(name)]
						: ["user-mode", modes[name] as string],
					header: hasCustomGroups.value ? name : null,
					count,
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					users: users.slice(first, last) as any[],
					before: first * rowHeight.value,
					after: (count - last) * rowHeight.value,
				};
			})
		);

		// Works out which rows are in view and draws those
		const measure = () => {
			const el = names.value;

			if (!el) {
				return;
			}

			const row = el.querySelector(".user");

			if (row) {
				const height = row.getBoundingClientRect().height;

				if (height > 0 && Math.abs(height - rowHeight.value) > 0.01) {
					rowHeight.value = height;
					// Spacers change with it, measure again once they did
					void nextTick(measure);
				}
			}

			const viewTop = el.getBoundingClientRect().top;
			const viewBottom = viewTop + el.clientHeight;
			const next: Record<string, RowRange> = {};
			let changed = false;

			shownGroups.value.forEach((group, index) => {
				const spacer = el.querySelector(`[data-rows-of="${index}"]`);
				const current = drawn.value[group.key];
				const inView = spacer
					? rowsInView(
							group.count,
							spacer.getBoundingClientRect().top,
							viewTop,
							viewBottom,
							rowHeight.value
						)
					: ([0, 0] as const);
				const range = rowsToDraw(group.count, inView, current);
				next[group.key] = range;

				if (!current || current[0] !== range[0] || current[1] !== range[1]) {
					changed = true;
				}
			});

			if (changed || Object.keys(next).length !== Object.keys(drawn.value).length) {
				drawn.value = next;
			}
		};

		let measureFrame = 0;

		const scheduleMeasure = () => {
			if (!measureFrame) {
				measureFrame = requestAnimationFrame(() => {
					measureFrame = 0;
					measure();
				});
			}
		};

		// Other users, a search, or another channel: once drawn, see what's in view
		watch(groupedUsers, () => void nextTick(measure));

		// Opening the list (it's hidden, not removed, while closed) and resizing
		let resizeObserver: ResizeObserver | undefined;

		onMounted(() => {
			if (typeof ResizeObserver !== "undefined" && names.value) {
				resizeObserver = new ResizeObserver(scheduleMeasure);
				resizeObserver.observe(names.value);
			}

			measure();
		});

		onUnmounted(() => {
			resizeObserver?.disconnect();
			cancelAnimationFrame(measureFrame);
		});

		const setUserSearchInput = (e: Event) => {
			userSearchInput.value = (e.target as HTMLInputElement).value;
		};

		const getModeClass = (mode: string) => {
			return modes[mode] as typeof modes;
		};

		const selectUser = () => {
			// Simulate a click on the active user to open the context menu.
			// Coordinates are provided to position the menu correctly.
			if (!activeUser.value || !userlist.value) {
				return;
			}

			const el = userlist.value.querySelector(".active");

			if (!el) {
				return;
			}

			const rect = el.getBoundingClientRect();
			const ev = new MouseEvent("click", {
				view: window,
				bubbles: true,
				cancelable: true,
				clientX: rect.left,
				clientY: rect.top + rect.height,
			});
			el.dispatchEvent(ev);
		};

		const hoverUser = (user: UserInMessage) => {
			activeUser.value = user;
		};

		const removeHoverUser = () => {
			activeUser.value = null;
		};

		// The active user's row may not be drawn: scroll to where it is in the list
		const scrollToActiveUser = () => {
			void nextTick(() => {
				const el = names.value;
				const user = activeUser.value;

				if (!el || !user) {
					return;
				}

				const index = groupEntries.value.findIndex(([, users]) =>
					users.some((u) => u === user || (u as {original?: unknown}).original === user)
				);

				if (index < 0) {
					return;
				}

				const row = groupEntries.value[index][1].findIndex(
					(u) => u === user || (u as {original?: unknown}).original === user
				);
				const spacer = el.querySelector(`[data-rows-of="${index}"]`);

				if (!spacer) {
					return;
				}

				const top =
					spacer.getBoundingClientRect().top -
					el.getBoundingClientRect().top +
					el.scrollTop +
					row * rowHeight.value;

				if (top < el.scrollTop) {
					el.scrollTop = top;
				} else if (top + rowHeight.value > el.scrollTop + el.clientHeight) {
					el.scrollTop = top + rowHeight.value - el.clientHeight;
				}

				measure();
			});
		};

		const navigateUserList = (event: Event, direction: number) => {
			// Prevent propagation to stop global keybind handler from capturing pagedown/pageup
			// and redirecting it to the message list container for scrolling
			event.stopImmediatePropagation();
			event.preventDefault();

			let users = props.channel.users;

			// Only using filteredUsers when we have to avoids filtering when it's not needed
			if (userSearchInput.value && filteredUsers.value) {
				users = filteredUsers.value.map((result) => result.original);
			}

			// Bail out if there's no users to select
			if (!users.length) {
				activeUser.value = null;
				return;
			}

			const abort = () => {
				activeUser.value = direction ? users[0] : users[users.length - 1];
				scrollToActiveUser();
			};

			// If there's no active user select the first or last one depending on direction
			if (!activeUser.value) {
				abort();
				return;
			}

			let currentIndex = users.indexOf(activeUser.value as ClientUser);

			if (currentIndex === -1) {
				abort();
				return;
			}

			currentIndex += direction;

			// Wrap around the list if necessary. Normaly each loop iterates once at most,
			// but might iterate more often if pgup or pgdown are used in a very short user list
			while (currentIndex < 0) {
				currentIndex += users.length;
			}

			while (currentIndex > users.length - 1) {
				currentIndex -= users.length;
			}

			activeUser.value = users[currentIndex];
			scrollToActiveUser();
		};

		return {
			filteredUsers,
			shownGroups,
			scheduleMeasure,
			userSearchInput,
			activeUser,
			userlist,
			names,
			getGroupSlug,
			setUserSearchInput,
			getModeClass,
			selectUser,
			hoverUser,
			removeHoverUser,
			navigateUserList,
		};
	},
});
</script>
