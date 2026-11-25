<template>
	<div id="chat-container" class="window">
		<div id="chat">
			<div
				v-if="network && channel"
				:id="`chan-${channel.id}`"
				class="chat-view conversation-details"
				data-type="details"
				role="tabpanel"
				aria-label="Conversation details"
			>
				<div class="header details-header">
					<button
						type="button"
						class="details-back"
						aria-label="Back to the conversation"
						@click="back"
					/>
					<span class="details-header-space" />
					<button
						type="button"
						class="details-action details-search"
						aria-label="Search this conversation"
						title="Search"
						@click="searchHere"
					/>
					<button
						type="button"
						class="details-action details-mute"
						:class="{muted: channel.muted}"
						:aria-pressed="channel.muted ? 'true' : 'false'"
						:aria-label="channel.muted ? 'Unmute' : 'Mute'"
						:title="channel.muted ? 'Unmute' : 'Mute'"
						@click="toggleMute"
					/>
				</div>
				<div class="details-scroll">
					<ProfileCard
						v-if="isQuery"
						:network="network"
						:channel="channel"
						:nick="channel.name"
						class="details-profile"
					/>
					<div v-else class="details-channel">
						<div class="details-channel-head">
							<span class="details-channel-icon" aria-hidden="true">#</span>
							<span class="details-channel-names">
								<span class="details-channel-name">{{
									channel.name.replace(/^#/, "")
								}}</span>
								<span class="details-channel-sub"
									>Channel on {{ network.name }}</span
								>
							</span>
						</div>
						<p v-if="channel.topic" class="details-channel-topic">
							<ParsedMessage :network="network" :text="channel.topic" />
						</p>
					</div>

					<nav class="details-tabs" role="tablist">
						<button
							v-for="t in tabs"
							:key="t.id"
							type="button"
							role="tab"
							class="details-tab"
							:aria-selected="tab === t.id ? 'true' : 'false'"
							@click="tab = t.id"
						>
							{{ t.label }}
						</button>
					</nav>

					<!-- Members, grouped by rank like Discord's roles -->
					<div v-if="tab === 'members'" class="details-members">
						<template v-for="group in memberGroups" :key="group.label">
							<div class="details-group">
								{{ group.label }} — {{ group.users.length }}
							</div>
							<div class="details-card">
								<div
									v-for="m in group.users"
									:key="m.nick"
									class="details-member"
									:class="{away: !!m.away}"
								>
									<span
										class="user details-member-avatar"
										:class="colorOf(m.nick)"
										:data-name="m.nick"
										aria-hidden="true"
									/>
									<span class="details-member-names">
										<Username :user="m" :channel="channel" :network="network">{{
											m.nick
										}}</Username>
										<span v-if="m.away" class="details-member-status">{{
											m.away
										}}</span>
									</span>
								</div>
							</div>
						</template>
					</div>

					<!-- Media -->
					<div v-else-if="tab === 'media'" class="details-media">
						<a
							v-for="item in media"
							:key="item.url"
							:href="item.url"
							target="_blank"
							rel="noopener"
							class="details-media-item"
							:title="item.url"
						>
							<img v-if="thumbOf(item)" :src="thumbOf(item)" alt="" loading="lazy" />
							<span v-else class="details-media-placeholder" />
						</a>
					</div>

					<!-- Links and files -->
					<div v-else class="details-links">
						<a
							v-for="item in tab === 'files' ? files : links"
							:key="item.url"
							:href="item.url"
							target="_blank"
							rel="noopener"
							class="details-link"
						>
							<span class="details-link-thumb">
								<img
									v-if="thumbOf(item)"
									:src="thumbOf(item)"
									alt=""
									loading="lazy"
								/>
								<span
									v-else
									class="details-link-icon"
									:class="tab === 'files' ? 'file' : 'link'"
								/>
							</span>
							<span class="details-link-title">{{ titleOf(item) }}</span>
							<span class="details-link-url">{{
								tab === "files" ? sizeOf(item) : item.url
							}}</span>
							<span class="details-link-from">
								<span
									class="user details-link-avatar"
									:class="colorOf(item.from)"
									:data-name="item.from"
									aria-hidden="true"
								/>
								{{ item.from || "someone" }}
							</span>
						</a>
					</div>

					<p v-if="tab !== 'members' && loading" class="details-empty">Loading…</p>
					<p
						v-else-if="tab !== 'members' && currentList.length === 0"
						class="details-empty"
					>
						{{ emptyText }}
					</p>
					<button
						v-if="tab !== 'members' && more && !loading"
						type="button"
						class="btn details-more"
						@click="load(true)"
					>
						Load older
					</button>
				</div>
			</div>
		</div>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, onBeforeUnmount, reactive, ref, watch} from "vue";
import {useRoute} from "vue-router";
import {useStore} from "../../js/store";
import socket from "../../js/socket";
import {switchToChannel} from "../../js/router";
import colorClass from "../../js/helpers/colorClass";
import {ChanType} from "../../../shared/types/chan";
import type {ConversationLink} from "../../../shared/types/profile";
import type {LinkPreview} from "../../../shared/types/msg";
import ProfileCard from "../ProfileCard.vue";
import Username from "../Username.vue";
import ParsedMessage from "../ParsedMessage.vue";

type Tab = "members" | "media" | "links" | "files";

const imageExt = /\.(png|jpe?g|gif|webp|avif|bmp)(\?|#|$)/i;
const videoExt = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
// Files uploaded through The Lounge: /uploads/<id>/<name>
const uploadPath = /\/uploads\/[a-z0-9]+\/[^/?#]+/i;

export default defineComponent({
	name: "ConversationDetails",
	components: {ProfileCard, Username, ParsedMessage},
	setup() {
		const store = useStore();
		const route = useRoute();

		const found = computed(() => store.getters.findChannel(Number(route.params.id)));
		const network = computed(() => found.value?.network);
		const channel = computed(() => found.value?.channel);
		const isQuery = computed(() => channel.value?.type === ChanType.QUERY);

		const tab = ref<Tab>("members");
		const tabs = [
			{id: "members", label: "Members"},
			{id: "media", label: "Media"},
			{id: "links", label: "Links"},
			{id: "files", label: "Files"},
		] as const;

		const items = ref<ConversationLink[]>([]);
		const previews = reactive(new Map<string, LinkPreview | null>());
		const loading = ref(false);
		const more = ref(false);
		let offset = 0;
		let autoPages = 0;
		const minItems = 30;
		const maxAutoPages = 10;

		const rankLabels: Record<string, string> = {
			"~": "Owners",
			"&": "Admins",
			"@": "Operators",
			"%": "Half-operators",
			"+": "Voiced",
		};

		const memberGroups = computed(() => {
			if (!channel.value || !network.value) {
				return [];
			}

			if (isQuery.value) {
				return [
					{
						label: "Members",
						users: [{nick: network.value.nick}, {nick: channel.value.name}],
					},
				];
			}

			const byName = (a: {nick: string}, b: {nick: string}) =>
				a.nick.localeCompare(b.nick, undefined, {sensitivity: "base"});
			const groups = new Map<string, typeof channel.value.users>();

			for (const user of channel.value.users) {
				const label = rankLabels[user.modes[0] || ""] || "Members";
				groups.set(label, [...(groups.get(label) || []), user]);
			}

			return [...Object.values(rankLabels), "Members"]
				.filter((label) => groups.has(label))
				.map((label) => ({label, users: groups.get(label)!.sort(byName)}));
		});

		const previewOf = (item: ConversationLink) =>
			item.preview || previews.get(item.url) || null;
		const isUpload = (item: ConversationLink) => uploadPath.test(item.url);

		const isMedia = (item: ConversationLink) => {
			const p = previewOf(item);
			return (
				p?.type === "image" ||
				p?.type === "video" ||
				imageExt.test(item.url) ||
				videoExt.test(item.url)
			);
		};

		const media = computed(() => items.value.filter((i) => isMedia(i)));
		const files = computed(() => items.value.filter((i) => isUpload(i)));
		const links = computed(() => items.value.filter((i) => !isMedia(i) && !isUpload(i)));
		const currentList = computed(() =>
			tab.value === "media" ? media.value : tab.value === "files" ? files.value : links.value
		);

		const thumbOf = (item: ConversationLink) => {
			const p = previewOf(item);
			return p && (p.type === "image" || p.type === "link") ? p.thumb || "" : "";
		};

		const titleOf = (item: ConversationLink) => {
			const p = previewOf(item);

			if (isUpload(item) || !p?.head) {
				try {
					const url = new URL(item.url);
					return isUpload(item)
						? decodeURIComponent(url.pathname.split("/").pop() || item.url)
						: url.hostname + url.pathname.replace(/\/$/, "");
				} catch {
					return item.url;
				}
			}

			return p.head;
		};

		const sizeOf = (item: ConversationLink) => {
			const size = previewOf(item)?.size ?? -1;

			if (size < 0) {
				return item.url;
			}

			const units = ["B", "KB", "MB", "GB"];
			let n = size;
			let u = 0;

			while (n >= 1024 && u < units.length - 1) {
				n /= 1024;
				u++;
			}

			return `${n.toFixed(u ? 2 : 0)} ${units[u]}`;
		};

		const colorOf = (nick: string) => colorClass(nick || "");

		const toggleMute = () => {
			if (channel.value) {
				socket.emit("mute:change", {
					target: channel.value.id,
					setMutedTo: !channel.value.muted,
				});
			}
		};

		// Back to the conversation with its search box open
		const searchHere = () => {
			if (!channel.value) {
				return;
			}

			switchToChannel(channel.value);
			setTimeout(() => {
				const input = document.querySelector<HTMLInputElement>(
					"#chat .header form.message-search input"
				);
				const toggle = document.querySelector<HTMLButtonElement>(
					"#chat .header form.message-search button.search"
				);

				if (toggle && toggle.offsetParent) {
					toggle.dispatchEvent(new MouseEvent("mousedown", {bubbles: true}));
				}

				input?.focus();
			}, 300);
		};

		const emptyText = computed(
			() =>
				({
					media: "No images or videos here yet.",
					links: "No links here yet.",
					files: "No uploaded files here yet.",
				})[tab.value as "media" | "links" | "files"]
		);

		// Previews for links from older history, a few at a time
		const queue: string[] = [];
		let inFlight = 0;

		const pump = () => {
			while (inFlight < 3 && queue.length) {
				const url = queue.shift()!;
				inFlight++;
				socket.emit("details:preview", {url});
			}
		};

		const onPreview = (data: {url: string; preview: LinkPreview | null}) => {
			if (!previews.has(data.url) || previews.get(data.url) === undefined) {
				previews.set(data.url, data.preview);
			}

			inFlight = Math.max(0, inFlight - 1);
			pump();
		};

		const onLinks = (data: {
			target: number;
			offset: number;
			items: ConversationLink[];
			more: boolean;
		}) => {
			if (data.target !== channel.value?.id || data.offset !== offset) {
				return;
			}

			loading.value = false;
			more.value = data.more;
			const seen = new Set(items.value.map((i) => i.url));
			const fresh = data.items.filter((i) => !seen.has(i.url));
			items.value = [...items.value, ...fresh];

			for (const item of fresh) {
				if (!item.preview && !previews.has(item.url)) {
					previews.set(item.url, undefined as unknown as null);
					queue.push(item.url);
				}
			}

			pump();

			// Busy channels repeat the same links: keep reading back until there's
			// a screenful, within a few pages per load
			if (data.more && items.value.length < minItems && autoPages < maxAutoPages) {
				autoPages++;
				load(true, true);
			}
		};

		socket.on("details:links", onLinks);
		socket.on("details:preview", onPreview);

		function load(older = false, auto = false) {
			if (!channel.value) {
				return;
			}

			if (!auto) {
				autoPages = 0;
			}

			if (older) {
				offset += 100;
			} else {
				offset = 0;
				items.value = [];
			}

			loading.value = true;
			socket.emit("details:links", {target: channel.value.id, offset});
		}

		watch(
			() => channel.value?.id,
			(id) => {
				if (id !== undefined) {
					tab.value = "members";
					load();

					// The member list is only fetched when a channel is opened
					if (channel.value?.usersOutdated) {
						channel.value.usersOutdated = false;
						socket.emit("names", {target: id});
					}
				}
			},
			{immediate: true}
		);

		const back = () => {
			if (channel.value) {
				switchToChannel(channel.value);
			}
		};

		onBeforeUnmount(() => {
			socket.off("details:links", onLinks);
			socket.off("details:preview", onPreview);
		});

		return {
			network,
			channel,
			isQuery,
			tab,
			tabs,
			memberGroups,
			toggleMute,
			searchHere,
			media,
			files,
			links,
			currentList,
			loading,
			more,
			load,
			thumbOf,
			titleOf,
			sizeOf,
			colorOf,
			emptyText,
			back,
		};
	},
});
</script>
