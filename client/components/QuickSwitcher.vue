<template>
	<div
		v-if="store.state.quickSwitcherOpen"
		class="quick-switcher-overlay"
		@mousedown.self="close"
	>
		<div class="quick-switcher" role="dialog" aria-label="Quick switcher">
			<input
				ref="input"
				v-model="query"
				type="text"
				class="quick-switcher-input"
				placeholder="Where would you like to go?"
				aria-label="Search channels, people and networks"
				autocomplete="off"
				@keydown.down.prevent="move(1)"
				@keydown.up.prevent="move(-1)"
				@keydown.enter.prevent="choose(results[selected])"
				@keydown.esc.prevent="close"
			/>
			<div class="quick-switcher-results" role="listbox">
				<div v-if="!query.trim()" class="quick-switcher-heading">
					{{ hasUnread ? "Unread and recent" : "Jump to" }}
				</div>
				<button
					v-for="(item, i) in results"
					:key="item.key"
					type="button"
					role="option"
					class="quick-switcher-item"
					:class="['type-' + item.type, {selected: i === selected}]"
					:aria-selected="i === selected ? 'true' : 'false'"
					:data-name="
						item.type === 'query' || item.type === 'start' ? item.label : undefined
					"
					@mouseenter="selected = i"
					@click="choose(item)"
				>
					<span
						class="quick-switcher-icon"
						:class="
							item.type === 'query' || item.type === 'start'
								? ['user', colorOf(item.label)]
								: ''
						"
						:data-name="
							item.type === 'query' || item.type === 'start' ? item.label : undefined
						"
						aria-hidden="true"
						>{{ item.type === "lobby" ? item.label.slice(0, 1) : "" }}</span
					>
					<span class="quick-switcher-label">
						<template v-if="item.type === 'start'">Message </template>{{ item.label }}
					</span>
					<span v-if="item.unread" class="quick-switcher-unread">{{ item.unread }}</span>
					<span class="quick-switcher-network">{{ item.network.name }}</span>
				</button>
				<p v-if="results.length === 0" class="quick-switcher-empty">
					Nothing matches “{{ query }}”.
				</p>
			</div>
			<div class="quick-switcher-tip">
				<kbd>↑</kbd><kbd>↓</kbd> to choose, <kbd>Enter</kbd> to go, <kbd>Esc</kbd> to close.
				Type a nick to start a conversation.
			</div>
		</div>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, nextTick, ref, watch} from "vue";
import {filter as fuzzyFilter} from "fuzzy";
import {useStore} from "../js/store";
import socket from "../js/socket";
import {switchToChannel} from "../js/router";
import colorClass from "../js/helpers/colorClass";
import {ChanType} from "../../shared/types/chan";
import type {ClientChan, ClientNetwork} from "../js/types";

type Item = {
	key: string;
	type: "channel" | "query" | "lobby" | "start";
	label: string;
	network: ClientNetwork;
	channel?: ClientChan;
	unread: number;
};

// What could be a nick to start a conversation with
const nickLike = /^[^\s,*?!@#&:+%~][^\s,*?!@]{0,63}$/;

export default defineComponent({
	name: "QuickSwitcher",
	setup() {
		const store = useStore();
		const query = ref("");
		const selected = ref(0);
		const input = ref<HTMLInputElement | null>(null);

		const items = computed<Item[]>(() =>
			store.state.networks.flatMap((network) =>
				network.channels
					.filter((c) => c.type !== ChanType.SPECIAL)
					.map((channel) => ({
						key: `${network.uuid}:${channel.id}`,
						type: channel.type as Item["type"],
						label: channel.type === ChanType.LOBBY ? network.name : channel.name,
						network,
						channel,
						unread: channel.muted ? 0 : channel.unread,
					}))
			)
		);

		const hasUnread = computed(() => items.value.some((i) => i.unread > 0));

		const results = computed<Item[]>(() => {
			const q = query.value.trim();
			const active = store.state.activeChannel?.channel;

			if (!q) {
				// Unread first, then everything else, without the open one
				return items.value
					.filter((i) => i.channel !== active)
					.sort((a, b) => b.unread - a.unread)
					.slice(0, 12);
			}

			const found = fuzzyFilter(q.replace(/^#/, ""), items.value, {
				extract: (i) => i.label,
			})
				.map((r) => r.original)
				.slice(0, 12);

			// "Message nick" on the current network when there's no DM with them yet
			const network =
				store.state.activeChannel?.network ||
				store.state.lastActiveChannel?.network ||
				store.state.networks[0];

			if (
				network &&
				nickLike.test(q) &&
				!network.channels.some((c) => c.name.toLowerCase() === q.toLowerCase())
			) {
				found.push({
					key: `start:${network.uuid}:${q}`,
					type: "start",
					label: q,
					network,
					unread: 0,
				});
			}

			return found;
		});

		watch(results, () => (selected.value = 0));

		const move = (by: number) => {
			const n = results.value.length;

			if (n) {
				selected.value = (selected.value + by + n) % n;
			}
		};

		const close = () => store.commit("quickSwitcherOpen", false);

		const choose = (item?: Item) => {
			if (!item) {
				return;
			}

			close();

			if (item.type === "start") {
				const lobby = item.network.channels[0];
				socket.emit("input", {target: lobby.id, text: `/query ${item.label}`});
			} else if (item.channel) {
				switchToChannel(item.channel);
			}
		};

		watch(
			() => store.state.quickSwitcherOpen,
			(open) => {
				if (open) {
					query.value = "";
					selected.value = 0;
					void nextTick(() => input.value?.focus());
				}
			}
		);

		const colorOf = (nick: string) => colorClass(nick);

		return {store, query, selected, input, results, hasUnread, move, close, choose, colorOf};
	},
});
</script>
