<template>
	<span v-if="gifsEnabled || emojiEnabled" class="expression-picker-wrap">
		<button
			v-if="gifsEnabled"
			id="gif"
			type="button"
			aria-label="Pick a GIF"
			title="GIF"
			:aria-expanded="open && tab === 'gifs' ? 'true' : 'false'"
			@click="toggle('gifs')"
		/>
		<button
			v-if="emojiEnabled"
			id="emoji"
			type="button"
			aria-label="Pick an emoji"
			title="Emoji"
			:aria-expanded="open && tab === 'emoji' ? 'true' : 'false'"
			@click="toggle('emoji')"
		/>
		<div
			v-if="open"
			ref="panel"
			class="expression-picker"
			role="dialog"
			aria-label="GIFs and emoji"
			@keydown.esc.stop.prevent="close(true)"
		>
			<nav class="expression-picker-tabs" role="tablist">
				<button
					v-if="gifsEnabled"
					type="button"
					role="tab"
					class="expression-picker-tab"
					:aria-selected="tab === 'gifs' ? 'true' : 'false'"
					@click="switchTab('gifs')"
				>
					GIFs
				</button>
				<button
					v-if="emojiEnabled"
					type="button"
					role="tab"
					class="expression-picker-tab"
					:aria-selected="tab === 'emoji' ? 'true' : 'false'"
					@click="switchTab('emoji')"
				>
					Emoji
				</button>
			</nav>

			<!-- Emoji -->
			<template v-if="tab === 'emoji'">
				<div class="emoji-picker-top">
					<input
						ref="searchInput"
						v-model="emojiSearch"
						type="search"
						class="expression-picker-search input"
						placeholder="Find the perfect emoji"
						aria-label="Search emoji"
						@keydown.enter.prevent="pickFirstEmoji"
					/>
					<span class="emoji-picker-big" aria-hidden="true">{{
						hovered ? hovered.emoji : "😀"
					}}</span>
				</div>
				<div class="emoji-picker-body">
					<nav
						v-if="!emojiSearch"
						class="emoji-picker-rail"
						aria-label="Emoji categories"
					>
						<button
							v-for="group in emojiGroups"
							:key="group.id"
							type="button"
							class="emoji-picker-rail-item"
							:title="group.label"
							:aria-label="group.label"
							@click="scrollToGroup(group.id)"
						>
							{{ group.icon }}
						</button>
					</nav>
					<div ref="emojiGrid" class="emoji-picker-grid">
						<section
							v-for="group in renderedEmojiGroups"
							:key="group.id"
							class="emoji-picker-section"
						>
							<button
								type="button"
								class="emoji-picker-group"
								:data-group="group.id"
								:aria-expanded="collapsed.has(group.id) ? 'false' : 'true'"
								@click="toggleGroup(group.id)"
							>
								<span class="emoji-picker-group-icon">{{ group.icon }}</span>
								{{ group.label }}
								<span class="emoji-picker-caret" aria-hidden="true" />
							</button>
							<div v-if="!collapsed.has(group.id)" class="emoji-picker-items">
								<button
									v-for="item in group.items"
									:key="group.id + item.name"
									type="button"
									class="emoji-picker-item"
									:aria-label="item.name.replace(/_/g, ' ')"
									@mouseenter="hovered = item"
									@focus="hovered = item"
									@click="pickEmoji(item, $event)"
								>
									{{ item.emoji }}
								</button>
							</div>
						</section>
						<p v-if="shownEmojiGroups.length === 0" class="expression-picker-empty">
							No emoji match “{{ emojiSearch }}”.
						</p>
					</div>
				</div>
				<div class="emoji-picker-footer">
					<template v-if="hovered">
						<span class="emoji-picker-preview">{{ hovered.emoji }}</span>
						<span class="emoji-picker-name">:{{ hovered.name }}:</span>
					</template>
					<span v-else class="emoji-picker-hint">Shift-click to pick several</span>
				</div>
			</template>

			<!-- GIFs -->
			<template v-else>
				<div class="gif-picker-top">
					<button
						v-if="gifView !== 'home'"
						type="button"
						class="gif-picker-back"
						aria-label="Back"
						@click="goHome"
					/>
					<input
						ref="searchInput"
						v-model="gifQuery"
						type="search"
						class="expression-picker-search input"
						:placeholder="gifsEnabled === 'tenor' ? 'Search Tenor' : 'Search GIPHY'"
						aria-label="Search GIFs"
						@input="onGifInput"
					/>
				</div>
				<div ref="gifGrid" class="gif-picker-grid" @scroll="onGifScroll">
					<div v-if="gifView === 'home'" class="gif-picker-tiles">
						<button
							type="button"
							class="gif-picker-tile favorites"
							@click="showFavorites"
						>
							<span>Favorites</span>
						</button>
						<button
							v-for="tile in tiles"
							:key="tile.q"
							type="button"
							class="gif-picker-tile"
							:style="
								tile.image
									? {backgroundImage: `url(${JSON.stringify(tile.image)})`}
									: {}
							"
							@click="openTile(tile.q)"
						>
							<span :class="{trending: tile.q === ''}">{{ tile.label }}</span>
						</button>
					</div>
					<template v-else>
						<div class="gif-picker-results">
							<div
								v-for="gif in gifView === 'favorites' ? favorites : gifs"
								:key="gif.id || gif.url"
								class="gif-picker-item"
								:style="{
									aspectRatio: `${gif.preview.width || 1} / ${gif.preview.height || 1}`,
								}"
							>
								<button
									type="button"
									class="gif-picker-send"
									:title="gif.title || 'Send GIF'"
									:aria-label="`Send ${gif.title || 'GIF'}`"
									@click="sendGif(gif)"
								>
									<video
										v-if="gif.preview.mp4"
										:src="gif.preview.mp4"
										autoplay
										loop
										muted
										playsinline
									/>
									<img
										v-else
										:src="gif.preview.url"
										:alt="gif.title"
										loading="lazy"
									/>
								</button>
								<button
									type="button"
									class="gif-picker-star"
									:class="{starred: isFavorite(gif)}"
									:aria-label="
										isFavorite(gif)
											? 'Remove from favorites'
											: 'Add to favorites'
									"
									:title="
										isFavorite(gif)
											? 'Remove from favorites'
											: 'Add to favorites'
									"
									@click.stop="toggleFavorite(gif)"
								/>
							</div>
						</div>
						<p v-if="gifError" class="expression-picker-empty">{{ gifError }}</p>
						<p
							v-else-if="
								!gifLoading && gifView === 'favorites' && favorites.length === 0
							"
							class="expression-picker-empty"
						>
							Star GIFs to keep them here.
						</p>
						<p
							v-else-if="!gifLoading && gifView === 'results' && gifs.length === 0"
							class="expression-picker-empty"
						>
							No GIFs found.
						</p>
						<p v-if="gifLoading" class="expression-picker-empty">Loading…</p>
					</template>
				</div>
				<div class="gif-picker-footer">
					{{ gifsEnabled === "tenor" ? "Via Tenor" : "Powered by GIPHY" }}
				</div>
			</template>
		</div>
	</span>
</template>

<script lang="ts">
import {computed, defineComponent, nextTick, onBeforeUnmount, reactive, ref} from "vue";
import emojiMap from "../js/helpers/simplemap.json" with {type: "json"};
import storage from "../js/localStorage";
import socket from "../js/socket";
import {useStore} from "../js/store";
import {feature} from "../js/features";
import type {Gif} from "../../shared/types/gifs";

type Item = {name: string; emoji: string};
type Tab = "emoji" | "gifs";

// simplemap.json follows Unicode's emoji order, so categories start at these
const categories = [
	{id: "people", label: "Smileys & People", start: "grinning", icon: "😀"},
	{id: "nature", label: "Animals & Nature", start: "monkey_face", icon: "🐵"},
	{id: "food", label: "Food & Drink", start: "grapes", icon: "🍇"},
	{id: "travel", label: "Travel & Places", start: "earth_africa", icon: "🌍"},
	{id: "activities", label: "Activities", start: "jack_o_lantern", icon: "🎃"},
	{id: "objects", label: "Objects", start: "eyeglasses", icon: "👓"},
	{id: "symbols", label: "Symbols", start: "atm", icon: "🏧"},
	{id: "flags", label: "Flags", start: "checkered_flag", icon: "🏁"},
];

const map = emojiMap as Record<string, string>;
const names = Object.keys(map);

const allGroups = categories.map((cat, i) => {
	const from = names.indexOf(cat.start);
	const next = categories[i + 1];
	const to = next ? names.indexOf(next.start) : names.length;
	return {...cat, names: names.slice(from, to)};
});
// Anything before the first category (e.g. :100:) is a symbol
allGroups[6].names.unshift(...names.slice(0, names.indexOf(categories[0].start)));

// One entry per emoji (the map has aliases)
const seen = new Set<string>();
const emojiData = allGroups.map((g) => ({
	id: g.id,
	label: g.label,
	icon: g.icon,
	items: g.names
		.filter((n) => !seen.has(map[n]) && seen.add(map[n]))
		.map((name) => ({name, emoji: map[name]})),
}));

// The GIF home screen: a tile per search, with that search's first GIF behind it
const tileQueries = [
	{q: "", label: "Trending GIFs"},
	{q: "hello", label: "hello"},
	{q: "lol", label: "lol"},
	{q: "love", label: "love"},
	{q: "happy birthday", label: "happy birthday"},
	{q: "thank you", label: "thank you"},
	{q: "wow", label: "wow"},
];

function readList<T>(key: string, valid: (v: unknown) => v is T): T[] {
	try {
		const parsed: unknown = JSON.parse(storage.get(key) || "[]");
		return Array.isArray(parsed) ? parsed.filter(valid) : [];
	} catch {
		return [];
	}
}

const isGif = (v: unknown): v is Gif =>
	!!v &&
	typeof v === "object" &&
	typeof (v as Gif).url === "string" &&
	(v as Gif).url.startsWith("https://") &&
	typeof (v as Gif).preview?.url === "string";

let requestCounter = 0;

export default defineComponent({
	name: "ExpressionPicker",
	emits: ["pick", "send-gif"],
	setup(_props, {emit}) {
		const store = useStore();
		const open = ref(false);
		const tab = ref<Tab>("emoji");
		const panel = ref<HTMLElement | null>(null);
		const searchInput = ref<HTMLInputElement | null>(null);

		// The GIF picker needs GIF search on the server, and both can be turned off
		const gifsEnabled = computed(() =>
			feature("gifPicker") ? store.state.serverConfiguration?.gifs || null : null
		);
		const emojiEnabled = computed(() => feature("emojiPicker"));

		// --- Emoji ---

		const emojiSearch = ref("");
		const hovered = ref<Item | null>(null);
		const collapsed = reactive(new Set<string>());
		const emojiGrid = ref<HTMLElement | null>(null);
		const recent = ref<string[]>(
			readList("emojiRecent", (n): n is string => typeof n === "string" && n in map)
		);

		const emojiGroups = computed(() => [
			...(recent.value.length
				? [
						{
							id: "recent",
							label: "Frequently Used",
							icon: "🕘",
							items: recent.value.map((name) => ({name, emoji: map[name]})),
						},
					]
				: []),
			...emojiData,
		]);

		const shownEmojiGroups = computed(() => {
			const needle = emojiSearch.value.trim().toLowerCase().replace(/^:|:$/g, "");

			if (!needle) {
				return emojiGroups.value;
			}

			const unique = new Map<string, Item>();

			for (const name of names
				.filter((n) => n.includes(needle))
				.sort((a, b) => Number(!a.startsWith(needle)) - Number(!b.startsWith(needle)))) {
				if (!unique.has(map[name])) {
					unique.set(map[name], {name, emoji: map[name]});
				}
			}

			return unique.size
				? [{id: "search", label: "Results", icon: "🔎", items: [...unique.values()]}]
				: [];
		});

		// Drawing every emoji at once is slow (each is a colour glyph): the first
		// sections show right away, the rest a frame at a time after
		const renderedCount = ref(2);
		let renderTimer = 0;

		const renderedEmojiGroups = computed(() =>
			emojiSearch.value
				? shownEmojiGroups.value
				: emojiGroups.value.slice(0, renderedCount.value)
		);

		const renderRest = () => {
			cancelAnimationFrame(renderTimer);

			const step = () => {
				if (renderedCount.value < emojiGroups.value.length) {
					renderedCount.value++;
					renderTimer = requestAnimationFrame(step);
				}
			};

			renderTimer = requestAnimationFrame(() => (renderTimer = requestAnimationFrame(step)));
		};

		const pickEmoji = (item: Item, e?: MouseEvent) => {
			recent.value = [item.name, ...recent.value.filter((n) => n !== item.name)].slice(0, 27);
			storage.set("emojiRecent", JSON.stringify(recent.value));
			emit("pick", item.emoji);

			if (!e?.shiftKey) {
				close(true);
			}
		};

		const pickFirstEmoji = () => {
			const first = shownEmojiGroups.value[0]?.items[0];

			if (first) {
				pickEmoji(first);
			}
		};

		const toggleGroup = (id: string) => {
			if (collapsed.has(id)) {
				collapsed.delete(id);
			} else {
				collapsed.add(id);
			}
		};

		const scrollToGroup = (id: string) => {
			collapsed.delete(id);
			renderedCount.value = emojiGroups.value.length;

			// Sections not drawn yet only have an estimated height: scroll again once
			// the ones passed over have been laid out
			const jump = (times: number) => {
				const header = emojiGrid.value?.querySelector<HTMLElement>(`[data-group="${id}"]`);

				if (header && emojiGrid.value) {
					emojiGrid.value.scrollTop = header.parentElement!.offsetTop;
				}

				if (times > 1) {
					requestAnimationFrame(() => jump(times - 1));
				}
			};

			void nextTick(() => jump(3));
		};

		// --- GIFs ---

		const gifQuery = ref("");
		const gifView = ref<"home" | "results" | "favorites">("home");
		const gifs = ref<Gif[]>([]);
		const gifNext = ref<string | null>(null);
		const gifLoading = ref(false);
		const gifError = ref("");
		const gifGrid = ref<HTMLElement | null>(null);
		const favorites = ref<Gif[]>(readList("gifFavorites", isGif));
		const tiles = ref(tileQueries.map((t) => ({...t, image: ""})));
		const pending = new Map<
			string,
			(r: {items: Gif[]; next: string | null; error?: string}) => void
		>();
		let activeRequest = "";
		let debounce: ReturnType<typeof setTimeout> | undefined;

		const onResults = (r: {id: string; items: Gif[]; next: string | null; error?: string}) => {
			pending.get(r.id)?.(r);
			pending.delete(r.id);
		};

		socket.on("gifs:results", onResults);

		const request = (q: string, pos: string | null) =>
			new Promise<{items: Gif[]; next: string | null; error?: string}>((resolve) => {
				const id = `g${++requestCounter}`;
				pending.set(id, resolve);
				socket.emit("gifs:search", {id, q, pos});
				setTimeout(() => {
					if (pending.has(id)) {
						pending.delete(id);
						resolve({items: [], next: null, error: "GIF search timed out"});
					}
				}, 15000);
			});

		const loadTiles = async () => {
			for (const tile of tiles.value) {
				if (!tile.image) {
					const r = await request(tile.q, null);
					tile.image = r.items[0]?.preview.url || "";
				}
			}
		};

		const runSearch = async (q: string, more = false) => {
			const id = `${q}\n${more ? gifNext.value : ""}`;
			activeRequest = id;
			gifLoading.value = true;
			gifError.value = "";
			const r = await request(q, more ? gifNext.value : null);

			if (activeRequest !== id) {
				return;
			}

			gifLoading.value = false;
			gifError.value = r.error || "";
			gifs.value = more ? [...gifs.value, ...r.items] : r.items;
			gifNext.value = r.next;
		};

		const onGifInput = () => {
			clearTimeout(debounce);
			const q = gifQuery.value.trim();

			if (!q) {
				gifView.value = "home";
				return;
			}

			gifView.value = "results";
			debounce = setTimeout(() => void runSearch(q), 350);
		};

		const openTile = (q: string) => {
			gifQuery.value = q;
			gifView.value = "results";
			gifs.value = [];
			void runSearch(q);
		};

		const showFavorites = () => {
			gifView.value = "favorites";
		};

		const goHome = () => {
			gifQuery.value = "";
			gifView.value = "home";
		};

		const onGifScroll = () => {
			const el = gifGrid.value;

			if (
				el &&
				gifView.value === "results" &&
				gifNext.value &&
				!gifLoading.value &&
				el.scrollTop + el.clientHeight > el.scrollHeight - 300
			) {
				void runSearch(gifQuery.value.trim(), true);
			}
		};

		const isFavorite = (gif: Gif) => favorites.value.some((f) => f.url === gif.url);

		const toggleFavorite = (gif: Gif) => {
			favorites.value = isFavorite(gif)
				? favorites.value.filter((f) => f.url !== gif.url)
				: [gif, ...favorites.value].slice(0, 100);
			storage.set("gifFavorites", JSON.stringify(favorites.value));
		};

		const sendGif = (gif: Gif) => {
			emit("send-gif", gif.url);
			close(true);
		};

		// --- Open / close ---

		function close(refocus: boolean) {
			open.value = false;
			emojiSearch.value = "";
			document.removeEventListener("mousedown", onOutside, true);

			if (refocus) {
				document.getElementById("input")?.focus();
			}
		}

		function onOutside(e: MouseEvent) {
			const target = e.target as HTMLElement;

			if (
				!panel.value?.contains(target) &&
				!target.closest?.(".expression-picker-wrap > button")
			) {
				close(false);
			}
		}

		const switchTab = (next: Tab) => {
			tab.value = next;
			void nextTick(() => searchInput.value?.focus());

			if (next === "gifs") {
				void loadTiles();
			} else {
				renderedCount.value = 2;
				renderRest();
			}
		};

		const toggle = (next: Tab) => {
			if (open.value && tab.value === next) {
				close(true);
				return;
			}

			if (!open.value) {
				open.value = true;
				document.addEventListener("mousedown", onOutside, true);
			}

			switchTab(next);
		};

		onBeforeUnmount(() => {
			document.removeEventListener("mousedown", onOutside, true);
			socket.off("gifs:results", onResults);
			cancelAnimationFrame(renderTimer);
			clearTimeout(debounce);
		});

		return {
			open,
			tab,
			panel,
			searchInput,
			gifsEnabled,
			emojiEnabled,
			emojiSearch,
			hovered,
			collapsed,
			emojiGrid,
			emojiGroups,
			shownEmojiGroups,
			renderedEmojiGroups,
			pickEmoji,
			pickFirstEmoji,
			toggleGroup,
			scrollToGroup,
			gifQuery,
			gifView,
			gifs,
			gifLoading,
			gifError,
			gifGrid,
			favorites,
			tiles,
			onGifInput,
			openTile,
			showFavorites,
			goHome,
			onGifScroll,
			isFavorite,
			toggleFavorite,
			sendGif,
			toggle,
			switchTab,
			close,
		};
	},
});
</script>
