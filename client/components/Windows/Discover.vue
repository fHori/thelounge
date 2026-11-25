<template>
	<div id="chat-container" class="window">
		<div id="chat">
			<div class="chat-view discover" data-type="special" aria-label="Discover channels">
				<div class="header">
					<SidebarToggle />
					<span class="title">Discover</span>
				</div>
				<div class="chat-content">
					<div class="chat">
						<div class="messages">
							<div class="msg">
								<div class="channel-browser">
									<div class="channel-browser-header">
										<h2 class="channel-browser-title">
											Channels on all networks
										</h2>
										<span class="channel-browser-count">
											{{ rows.length }}
											{{ rows.length === 1 ? "channel" : "channels" }}
										</span>
										<button
											type="button"
											class="btn btn-small channel-browser-refresh"
											@click="refresh"
										>
											Refresh
										</button>
									</div>

									<p
										v-for="n in loadingNetworks"
										:key="n.uuid"
										class="channel-browser-status"
									>
										{{ n.name }}: {{ n.status }}
									</p>

									<div class="channel-browser-tools">
										<input
											v-model="search"
											type="search"
											class="input channel-browser-search"
											placeholder="Search channels on every network"
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

									<ul class="channel-browser-list">
										<li
											v-for="row in shown"
											:key="row.network.uuid + row.key"
											class="channel-browser-item"
											:class="{joined: row.joined}"
										>
											<button
												type="button"
												class="channel-browser-name"
												@click="row.joined ? open(row) : join(row)"
											>
												<span
													class="channel-browser-icon"
													aria-hidden="true"
												/>
												<span class="channel-browser-label">{{
													row.channel
												}}</span>
												<span class="channel-browser-network">{{
													row.network.name
												}}</span>
											</button>
											<div class="channel-browser-meta">
												<span class="channel-browser-users">
													{{ row.num_users }}
													{{ row.num_users === 1 ? "user" : "users" }}
												</span>
												<span
													v-if="row.topic"
													class="channel-browser-topic"
												>
													<ParsedMessage
														:network="row.network"
														:text="row.topic"
													/>
												</span>
											</div>
											<button
												type="button"
												class="channel-browser-join"
												:class="{
													pending: pending.has(
														row.network.uuid + row.key
													),
												}"
												:aria-pressed="row.joined ? 'true' : 'false'"
												:aria-label="
													row.joined
														? `Joined ${row.channel}`
														: `Join ${row.channel}`
												"
												:title="row.joined ? 'Joined' : 'Join'"
												@click="row.joined ? open(row) : join(row)"
											>
												{{ row.joined ? "Joined" : "Join" }}
											</button>
										</li>
									</ul>
									<p
										v-if="!loadingNetworks.length && shown.length === 0"
										class="channel-browser-status"
									>
										{{
											search
												? `No channels match “${search}”.`
												: "No channels listed."
										}}
									</p>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, onMounted, reactive, ref} from "vue";
import {useStore} from "../../js/store";
import socket from "../../js/socket";
import {switchToChannel} from "../../js/router";
import {joinQuietly} from "../../js/quietJoins";
import {ChanState, ChanType, SpecialChanType} from "../../../shared/types/chan";
import type {ClientNetwork} from "../../js/types";
import SidebarToggle from "../SidebarToggle.vue";
import ParsedMessage from "../ParsedMessage.vue";

type Listed = {channel: string; num_users?: number; topic?: string};

/**
 * Channels on every connected network: runs the channel list on each and
 * shows them together (each network's list also stays in its own browser).
 */
export default defineComponent({
	name: "Discover",
	components: {SidebarToggle, ParsedMessage},
	setup() {
		const store = useStore();
		const search = ref("");
		const sort = ref<"users" | "name">("users");
		const pending = reactive(new Set<string>());

		const connected = computed(() => store.state.networks.filter((n) => n.status.connected));

		const listOf = (network: ClientNetwork) =>
			network.channels.find(
				(c) => c.type === ChanType.SPECIAL && c.special === SpecialChanType.CHANNELLIST
			);

		const loadingNetworks = computed(() =>
			connected.value
				.map((network) => {
					const data = listOf(network)?.data as {text?: string} | Listed[] | undefined;
					return {
						uuid: network.uuid,
						name: network.name,
						status: Array.isArray(data)
							? ""
							: data?.text || "Asking for the channel list…",
					};
				})
				.filter((n) => n.status)
		);

		const rows = computed(() =>
			connected.value.flatMap((network) => {
				const data = listOf(network)?.data;
				const joined = new Set(
					network.channels
						.filter((c) => c.type === ChanType.CHANNEL && c.state === ChanState.JOINED)
						.map((c) => c.name.toLowerCase())
				);
				return Array.isArray(data)
					? (data as Listed[]).map((c) => ({
							...c,
							network,
							key: c.channel.toLowerCase(),
							num_users: c.num_users || 0,
							joined: joined.has(c.channel.toLowerCase()),
						}))
					: [];
			})
		);

		const shown = computed(() => {
			const needle = search.value.trim().toLowerCase();
			const list = rows.value.filter(
				(r) =>
					!needle ||
					r.key.includes(needle) ||
					(r.topic || "").toLowerCase().includes(needle) ||
					r.network.name.toLowerCase().includes(needle)
			);

			return sort.value === "name"
				? list.sort((a, b) => a.key.localeCompare(b.key))
				: list.sort((a, b) => b.num_users - a.num_users || a.key.localeCompare(b.key));
		});

		// Each network's list window is created when its list starts; it opens in
		// the background so Discover stays shown
		const requestList = (network: ClientNetwork) => {
			// Long lists arrive in several updates
			joinQuietly(network.uuid, listOf(network)?.name || "Channel List", 60000);

			socket.emit("input", {target: network.channels[0].id, text: "/list"});
		};

		const refresh = () => connected.value.forEach(requestList);

		const join = (row: {network: ClientNetwork; channel: string; key: string}) => {
			pending.add(row.network.uuid + row.key);
			joinQuietly(row.network.uuid, row.channel);
			socket.emit("input", {
				target: row.network.channels[0].id,
				text: `/join ${row.channel}`,
			});
		};

		const open = (row: {network: ClientNetwork; key: string}) => {
			const chan = row.network.channels.find((c) => c.name.toLowerCase() === row.key);

			if (chan) {
				switchToChannel(chan);
			}
		};

		// Lists a network has already loaded are shown right away; the others are asked for
		onMounted(() => {
			for (const network of connected.value) {
				if (!Array.isArray(listOf(network)?.data)) {
					requestList(network);
				}
			}
		});

		return {search, sort, pending, rows, shown, loadingNetworks, refresh, join, open};
	},
});
</script>
