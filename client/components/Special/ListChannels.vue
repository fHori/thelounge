<template>
	<div class="channel-browser">
		<div class="channel-browser-header">
			<h2 class="channel-browser-title">Browse channels</h2>
			<span v-if="channels" class="channel-browser-count">
				{{ shown.length === channels.length ? "" : `${shown.length} of `
				}}{{ channels.length }}
				{{ channels.length === 1 ? "channel" : "channels" }}
			</span>
			<button
				type="button"
				class="btn btn-small channel-browser-refresh"
				:disabled="!channels || undefined"
				@click="refresh"
			>
				Refresh
			</button>
		</div>

		<p v-if="!channels" class="channel-browser-status">{{ statusText }}</p>

		<template v-else>
			<div class="channel-browser-tools">
				<input
					ref="searchInput"
					v-model="search"
					type="search"
					class="input channel-browser-search"
					placeholder="Search channels"
					aria-label="Search channels by name or topic"
					autocomplete="off"
				/>
				<label class="channel-browser-sort">
					<span class="sr-only">Sort by</span>
					<select v-model="sort" class="input">
						<option value="users">Most users</option>
						<option value="name">Name</option>
					</select>
				</label>
			</div>

			<template v-for="group in groups" :key="group.id">
				<h3 v-if="group.items.length" class="channel-browser-group">
					{{ group.label }}
				</h3>
				<ul v-if="group.items.length" class="channel-browser-list">
					<li
						v-for="chan in group.items"
						:key="chan.channel"
						class="channel-browser-item"
						:class="{joined: chan.joined}"
					>
						<button
							type="button"
							class="channel-browser-name"
							:title="chan.joined ? `Open ${chan.channel}` : `Join ${chan.channel}`"
							@click="chan.joined ? open(chan.channel) : join(chan.channel, true)"
						>
							<span class="channel-browser-icon" aria-hidden="true" />
							<span class="channel-browser-label">{{ chan.channel }}</span>
						</button>
						<div class="channel-browser-meta">
							<span class="channel-browser-users">
								{{ chan.num_users }} {{ chan.num_users === 1 ? "user" : "users" }}
							</span>
							<span v-if="chan.topic" class="channel-browser-topic">
								<ParsedMessage :network="network" :text="chan.topic" />
							</span>
						</div>
						<button
							type="button"
							class="channel-browser-join"
							:class="{pending: pending.has(chan.key)}"
							:aria-pressed="chan.joined ? 'true' : 'false'"
							:aria-label="
								chan.joined ? `Joined ${chan.channel}` : `Join ${chan.channel}`
							"
							:title="chan.joined ? 'Joined' : 'Join'"
							:disabled="(!chan.joined && pending.has(chan.key)) || undefined"
							@click="chan.joined ? open(chan.channel) : join(chan.channel, false)"
						>
							{{
								chan.joined ? "Joined" : pending.has(chan.key) ? "Joining…" : "Join"
							}}
						</button>
					</li>
				</ul>
			</template>

			<p v-if="shown.length === 0" class="channel-browser-status">
				No channels match “{{ search }}”.
			</p>
		</template>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, PropType, reactive, ref, watch} from "vue";
import {ChanState, ChanType} from "../../../shared/types/chan";
import {ClientChan, ClientNetwork} from "../../js/types";
import socket from "../../js/socket";
import {switchToChannel} from "../../js/router";
import {joinQuietly} from "../../js/quietJoins";
import ParsedMessage from "../ParsedMessage.vue";

type ListedChannel = {channel: string; num_users?: number; topic?: string};

export default defineComponent({
	name: "ListChannels",
	components: {
		ParsedMessage,
	},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
	},
	setup(props) {
		const search = ref("");
		const sort = ref<"users" | "name">("users");
		const pending = reactive(new Set<string>());

		// The server sends {text} while loading, then the list
		const channels = computed<ListedChannel[] | null>(() =>
			Array.isArray(props.channel.data) ? (props.channel.data as ListedChannel[]) : null
		);
		const statusText = computed(() => {
			const data = props.channel.data as {text?: string} | undefined;
			return data && typeof data.text === "string" ? data.text : "Loading channels…";
		});

		const joinedNames = computed(
			() =>
				new Set(
					props.network.channels
						.filter((c) => c.type === ChanType.CHANNEL && c.state === ChanState.JOINED)
						.map((c) => c.name.toLowerCase())
				)
		);

		watch(joinedNames, (names) => {
			for (const key of pending) {
				if (names.has(key)) {
					pending.delete(key);
				}
			}
		});

		const shown = computed(() => {
			const needle = search.value.trim().toLowerCase();
			const list = (channels.value || [])
				.map((c) => ({
					...c,
					key: c.channel.toLowerCase(),
					num_users: c.num_users || 0,
					joined: joinedNames.value.has(c.channel.toLowerCase()),
				}))
				.filter(
					(c) =>
						!needle ||
						c.key.includes(needle) ||
						(c.topic || "").toLowerCase().includes(needle)
				);

			return sort.value === "name"
				? list.sort((a, b) => a.key.localeCompare(b.key))
				: list.sort((a, b) => b.num_users - a.num_users || a.key.localeCompare(b.key));
		});

		// Channels joined from here stay where they are until the next refresh, so
		// rows don't move under the pointer while joining several
		const joinedHere = reactive(new Set<string>());
		const inJoined = (c: {key: string; joined: boolean}) => c.joined && !joinedHere.has(c.key);
		const groups = computed(() => [
			{id: "joined", label: "Joined", items: shown.value.filter(inJoined)},
			{id: "other", label: "Other channels", items: shown.value.filter((c) => !inJoined(c))},
		]);

		watch(channels, () => joinedHere.clear());

		const join = (name: string, andOpen: boolean) => {
			pending.add(name.toLowerCase());
			joinedHere.add(name.toLowerCase());

			if (!andOpen) {
				// Stay here so several channels can be joined in a row
				joinQuietly(props.network.uuid, name);
			}

			socket.emit("input", {target: props.channel.id, text: `/join ${name}`});
		};

		const open = (name: string) => {
			const chan = props.network.channels.find(
				(c) => c.name.toLowerCase() === name.toLowerCase()
			);

			if (chan) {
				switchToChannel(chan);
			}
		};

		const refresh = () => socket.emit("input", {target: props.channel.id, text: "/list"});

		return {
			search,
			sort,
			pending,
			channels,
			statusText,
			shown,
			groups,
			join,
			open,
			refresh,
		};
	},
});
</script>
