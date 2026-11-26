<template>
	<div id="chat-container" class="window">
		<div
			id="chat"
			:class="{
				'time-seconds': store.state.settings.showSeconds,
				'time-12h': store.state.settings.use12hClock,
			}"
		>
			<div
				class="chat-view"
				data-type="search-results"
				aria-label="Search results"
				role="tabpanel"
			>
				<div v-if="network && channel" class="header">
					<SidebarToggle />
					<span class="title"
						>Searching in <span class="channel-name">{{ channel.name }}</span> for</span
					>
					<span class="topic">{{ route.query.q }}</span>
					<MessageSearchForm :network="network" :channel="channel" />
					<button
						class="close"
						aria-label="Close search window"
						title="Close search window"
						@click="closeSearch"
					/>
				</div>
				<div v-if="network && channel" class="chat-content">
					<div
						v-if="searching"
						class="search-progress"
						role="progressbar"
						aria-label="Searching"
					/>
					<div ref="chat" class="chat" tabindex="-1" :aria-busy="searching">
						<div v-show="moreResultsAvailable || (searching && more)" class="show-more">
							<button
								ref="loadMoreButton"
								:disabled="searching || !store.state.isConnected"
								class="btn"
								@click="onShowMoreClick"
							>
								<span v-if="searching">Loading…</span>
								<span v-else>Show older messages</span>
							</button>
						</div>

						<div
							v-if="searching && !messages.length && !more"
							class="search-skeleton"
							aria-label="Searching…"
						>
							<div v-for="n in 6" :key="n" class="search-skeleton-row">
								<span class="search-skeleton-time" />
								<span class="search-skeleton-from" />
								<span
									class="search-skeleton-text"
									:style="{width: `${30 + ((n * 37) % 50)}%`}"
								/>
							</div>
						</div>
						<div
							v-else-if="!searching && !messages.length && !more"
							class="search-status"
						>
							No results found.
						</div>
						<div
							class="messages"
							role="log"
							aria-live="polite"
							aria-relevant="additions"
						>
							<div
								v-for="(message, id) in messages"
								:key="messageKey(message)"
								class="result"
								:data-jump-to="store.state.settings.searchEnabled || undefined"
							>
								<DateMarker
									v-if="shouldDisplayDateMarker(message, id)"
									:key="messageKey(message) + '-date'"
									:message="message"
								/>
								<Message
									:key="messageKey(message)"
									:channel="channel"
									:network="network"
									:message="message"
									:data-id="message.id"
									@click="jump(message)"
								/>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<style>
.channel-name {
	font-weight: 700;
}

.result[data-jump-to] > .msg {
	cursor: pointer;

	&:hover {
		background-color: var(--highlight-bg-color) !important;
	}
}

.chat-view[data-type="search-results"] .chat-content {
	margin-top: 45px;
	position: relative;
}

/* A thin bar sweeping across the top while results are still coming in */
.search-progress {
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	height: 2px;
	z-index: 1;
	overflow: hidden;
	background: color-mix(in srgb, var(--link-color) 20%, transparent);
}

.search-progress::after {
	content: "";
	position: absolute;
	top: 0;
	bottom: 0;
	width: 30%;
	background: var(--link-color);
	animation: search-progress 1.2s ease-in-out infinite;
}

@keyframes search-progress {
	from {
		left: -30%;
	}

	to {
		left: 100%;
	}
}

/* Placeholder rows until the first results arrive */
.search-skeleton {
	padding: 10px 0;
}

.search-skeleton-row {
	display: flex;
	align-items: center;
	gap: 12px;
	height: 26px;
	padding: 0 10px;
}

.search-skeleton-row span {
	height: 10px;
	border-radius: 5px;
	background:
		linear-gradient(
				90deg,
				transparent 0%,
				color-mix(in srgb, var(--body-color) 12%, transparent) 50%,
				transparent 100%
			)
			0 0 / 200% 100%,
		color-mix(in srgb, var(--body-color) 8%, transparent);
	animation: search-shimmer 1.4s linear infinite;
}

.search-skeleton-time {
	flex: 0 0 46px;
}

.search-skeleton-from {
	flex: 0 0 80px;
}

@keyframes search-shimmer {
	from {
		background-position:
			200% 0,
			0 0;
	}

	to {
		background-position:
			-200% 0,
			0 0;
	}
}

@media (prefers-reduced-motion: reduce) {
	.search-progress::after {
		left: 0;
		width: 100%;
		animation: none;
		opacity: 0.5;
	}

	.search-skeleton-row span {
		animation: none;
	}
}
</style>

<script lang="ts">
import socket from "../../js/socket";
import {searchSent} from "../../js/searchTiming";
import eventbus from "../../js/eventbus";

import SidebarToggle from "../SidebarToggle.vue";
import Message from "../Message.vue";
import MessageSearchForm from "../MessageSearchForm.vue";
import DateMarker from "../DateMarker.vue";
import {watch, computed, defineComponent, nextTick, ref, onMounted, onUnmounted} from "vue";
import type {ClientMessage} from "../../js/types";

import {useStore} from "../../js/store";
import {useRoute} from "vue-router";
import {switchToChannel} from "../../js/router";
import type {SearchCursor, SearchRequest} from "../../../shared/types/storage";
import {messageKey} from "../../../shared/messageKey";

// Ids tell this browser's searches apart, so late results of a replaced one
// are dropped
let nextSearchId = 1;

export default defineComponent({
	name: "SearchResults",
	components: {
		SidebarToggle,
		Message,
		DateMarker,
		MessageSearchForm,
	},
	setup() {
		const store = useStore();
		const route = useRoute();

		const chat = ref<HTMLDivElement>();

		const loadMoreButton = ref<HTMLButtonElement>();

		const searching = computed(
			() => !!store.state.messageSearch && !store.state.messageSearch.done
		);
		const more = computed(() => !!store.state.messageSearch?.more);
		const moreResultsAvailable = computed(
			() => !!store.state.messageSearch?.done && store.state.messageSearch.cursor !== null
		);
		const oldScrollTop = ref(0);
		const oldChatHeight = ref(0);

		const messages = computed(() => {
			const results = store.state.messageSearchResults?.results;

			if (!results) {
				return [];
			}

			return results;
		});

		const chan = computed(() => {
			const chanId = parseInt(String(route.params.id || ""), 10);
			return store.getters.findChannel(chanId);
		});

		const network = computed(() => {
			if (!chan.value) {
				return null;
			}

			return chan.value.network;
		});

		const channel = computed(() => {
			if (!chan.value) {
				return null;
			}

			return chan.value.channel;
		});

		const setActiveChannel = () => {
			if (!chan.value) {
				return;
			}

			store.commit("activeChannel", chan.value);
		};

		const closeSearch = () => {
			if (!channel.value) {
				return;
			}

			switchToChannel(channel.value);
		};

		const shouldDisplayDateMarker = (message: ClientMessage, id: number) => {
			const previousMessage = messages.value[id - 1];

			if (!previousMessage) {
				return true;
			}

			return new Date(previousMessage.time).getDay() !== new Date(message.time).getDay();
		};

		// Tells the server to stop a search still running, which it does at
		// its next batch
		const cancelSearch = () => {
			const search = store.state.messageSearch;

			if (search && !search.done) {
				socket.emit("search:cancel", search.id);
			}
		};

		const clearSearchState = () => {
			cancelSearch();
			store.commit("messageSearchResults", null);
			store.commit("messageSearch", null);
		};

		const send = (cursor: SearchCursor | null) => {
			if (!network.value || !channel.value) {
				return;
			}

			const request: SearchRequest = {
				id: nextSearchId++,
				networkUuid: network.value.uuid,
				channelName: channel.value.name,
				searchTerm: String(route.query.q || ""),
				cursor,
			};
			store.commit("messageSearch", {
				id: request.id,
				cursor: null,
				done: false,
				more: cursor !== null,
			});
			searchSent();
			socket.emit("search", request);
		};

		const doSearch = () => {
			clearSearchState(); // this is a new search, so we need to clear anything before that
			send(null);
		};

		const onShowMoreClick = () => {
			const cursor = store.state.messageSearch?.cursor;

			if (!chat.value || !cursor) {
				return;
			}

			oldScrollTop.value = chat.value.scrollTop;
			oldChatHeight.value = chat.value.scrollHeight;
			send(cursor);
		};

		const jumpToBottom = async () => {
			await nextTick();

			const el = chat.value;

			if (!el) {
				return;
			}

			el.scrollTop = el.scrollHeight;
		};

		// Jump to a search result - navigate to channel with message ID and time
		// If message isn't in memory, MessageList will scroll to closest match by time
		const jump = (message: ClientMessage) => {
			if (!store.state.settings.searchEnabled || !channel.value) {
				return;
			}

			const messageTime = new Date(message.time).getTime();
			switchToChannel(channel.value, message.id, messageTime);
		};

		watch(
			() => route.params.id,
			() => {
				doSearch();
				setActiveChannel();
			}
		);

		watch(
			() => route.query,
			() => {
				doSearch();
				setActiveChannel();
			}
		);

		// Results come in batches: the newest page keeps to the bottom, older
		// ones keep what is in view where it is as they appear above it
		watch(messages, async () => {
			if (!more.value) {
				await jumpToBottom();
				return;
			}

			await nextTick();

			const el = chat.value;

			if (!el) {
				return;
			}

			el.scrollTop = oldScrollTop.value + el.scrollHeight - oldChatHeight.value;
			oldScrollTop.value = el.scrollTop;
			oldChatHeight.value = el.scrollHeight;
		});

		onMounted(() => {
			setActiveChannel();
			doSearch();

			eventbus.on("escapekey", closeSearch);
			eventbus.on("re-search", doSearch);
		});

		onUnmounted(() => {
			eventbus.off("escapekey", closeSearch);
			eventbus.off("re-search", doSearch);
			clearSearchState();
		});

		return {
			chat,
			loadMoreButton,
			messages,
			moreResultsAvailable,
			searching,
			more,
			network,
			channel,
			route,
			store,
			setActiveChannel,
			closeSearch,
			shouldDisplayDateMarker,
			doSearch,
			onShowMoreClick,
			jumpToBottom,
			jump,
			messageKey,
		};
	},
});
</script>
