<template>
	<div ref="chat" class="chat" tabindex="-1">
		<div v-show="showLoadMoreButton" class="show-more">
			<button
				ref="loadMoreButton"
				:disabled="channel.historyLoading || !store.state.isConnected"
				class="btn"
				@click="onShowMoreClick"
			>
				<span v-if="channel.historyLoading">Loading…</span>
				<span v-else>Show older messages</span>
			</button>
		</div>
		<div
			class="messages"
			role="log"
			aria-live="polite"
			aria-relevant="additions"
			@copy="onCopy"
		>
			<template v-for="(message, idx) in displayedMessages" :key="getMessageKey(message)">
				<DateMarker
					v-if="shouldDisplayDateMarker(idx)"
					:message="message as any"
					:is-focused="isMessageFocused(message)"
				/>
				<div v-if="shouldDisplayUnreadMarker(idx)" class="unread-marker">
					<span class="unread-marker-text" />
				</div>

				<MessageCondensed
					v-if="message.type === 'condensed'"
					:network="network"
					:keep-scroll-position="keepScrollPosition"
					:messages="message.messages"
					:is-focused="isMessageFocused(message)"
				/>
				<Message
					v-else
					:channel="channel"
					:network="network"
					:message="message"
					:keep-scroll-position="keepScrollPosition"
					:is-previous-source="isPreviousSource(message, idx)"
					:is-focused="isMessageFocused(message)"
					@toggle-link-preview="onLinkPreviewToggle"
				/>
			</template>
		</div>
		<div v-show="showLoadNewerButton" class="show-more">
			<button
				ref="loadNewerButton"
				:disabled="channel.historySlice?.loadingNewer || !store.state.isConnected"
				class="btn"
				@click="onShowNewerClick"
			>
				<span v-if="channel.historySlice?.loadingNewer">Loading…</span>
				<span v-else>Show newer messages</span>
			</button>
		</div>
	</div>
</template>

<script lang="ts">
import {condensedTypes} from "../../shared/irc";
import {ChanType} from "../../shared/types/chan";
import {MessageType} from "../../shared/types/msg";
import eventbus from "../js/eventbus";
import clipboard from "../js/clipboard";
import socket from "../js/socket";
import {cancelPendingJump, leaveHistorySlice, startPendingJump} from "../js/chan";
import {startsNewDay, unreadMarkerIndex} from "../js/helpers/messageMarkers";
import Message from "./Message.vue";
import MessageCondensed from "./MessageCondensed.vue";
import DateMarker from "./DateMarker.vue";
import {
	computed,
	defineComponent,
	nextTick,
	onBeforeUnmount,
	onMounted,
	onUnmounted,
	PropType,
	ref,
	watch,
} from "vue";
import {useStore} from "../js/store";
import {ClientChan, ClientMessage, ClientNetwork, ClientLinkPreview} from "../js/types";

type CondensedMessageContainer = {
	type: "condensed";
	time: Date;
	messages: ClientMessage[];
	id?: number;
};

// Render at most this many messages - keeps DOM manageable
const MAX_RENDERED_MESSAGES = 500;

// What a jump is trying to reach: a message id, the time it was sent, or both
type JumpTarget = {id: number | null; time: number | null};

// After a jump the target is kept in place this long while the page settles
const JUMP_HOLD_MS = 1500;

// A touch scroll keeps going this long after the finger lifts (momentum)
const TOUCH_MOMENTUM_MS = 1500;

// After a page of older history arrives, "show older" isn't pressed for the
// user again until this much later, so one swipe can't chain page after page
const AUTO_LOAD_COOLDOWN_MS = 1000;

// Scrolling up asks for the next page of older history while this many
// entries are still above the rendered window, or, with the oldest loaded
// entry rendered, this many screens above the view. The page is then
// usually there before the top is reached.
const PREFETCH_ENTRIES = 150;
const PREFETCH_SCREENS = 2;

export default defineComponent({
	name: "MessageList",
	components: {
		Message,
		MessageCondensed,
		DateMarker,
	},
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
		isFocused: Number,
		focusedTime: Number,
	},
	setup(props) {
		const store = useStore();

		const chat = ref<HTMLDivElement | null>(null);
		const loadMoreButton = ref<HTMLButtonElement | null>(null);
		const loadNewerButton = ref<HTMLButtonElement | null>(null);
		const historyObserver = ref<IntersectionObserver | null>(null);

		// Key (see getMessageKey) of the entry a jump landed on, which is highlighted
		const focusedKey = ref<string | null>(null);

		// True from the moment a jump starts until its target has settled in
		// view. Everything else that moves the scroll position stays out of
		// the way meanwhile.
		const jumping = ref(false);

		// A jump waiting for its target to be fetched from the server
		let pendingJump: JumpTarget | null = null;
		let stopHolding: (() => void) | null = null;

		// Set to handleScroll once that exists further down
		let syncScrollState = () => {};

		// Flag to prevent scroll handler during programmatic scrolls
		const isScrolling = ref(false);

		// Window start index for virtual scrolling - tracks which message index to start from
		const windowStartIndex = ref(0);

		// Track if we're currently adjusting the window (to prevent scroll handler interference)
		const isAdjustingWindow = ref(false);

		// Threshold for triggering window shifts (in pixels from edge)
		const SCROLL_THRESHOLD = 200;

		// Whether a finger is on the list, and when one last touched or left it
		let touching = false;
		let lastTouchAt = 0;

		const onTouchStart = () => {
			touching = true;
			lastTouchAt = Date.now();
		};

		const onTouchEnd = () => {
			touching = false;
			lastTouchAt = Date.now();
		};

		// When the last page of older history arrived, and the pending
		// re-check of the "show older" button once the cooldown is over
		let olderPageArrivedAt = 0;
		let autoLoadRecheck: ReturnType<typeof setTimeout> | undefined = undefined;

		// Moves the list to `top`. During a touch scroll iOS Safari drops a
		// scrollTop set from script (the momentum carries on from where it
		// was), so whatever was just added above takes over the view: the
		// user lands in the history that was loaded, near its top again,
		// which loads the next page, and so on, days back. Turning scrolling
		// off for a frame ends the momentum and makes the new position stick.
		const setScrollTop = (el: HTMLElement, top: number) => {
			if (!touching && Date.now() - lastTouchAt > TOUCH_MOMENTUM_MS) {
				el.scrollTop = top;
				return;
			}

			el.style.overflowY = "hidden";
			el.scrollTop = top;

			requestAnimationFrame(() => {
				el.style.overflowY = "";
				// Again, in case the frame without scrolling reset it
				el.scrollTop = top;
			});
		};

		// Build condensed message list (all messages, before windowing)
		const allCondensedMessages = computed(() => {
			if (props.channel.type !== ChanType.CHANNEL && props.channel.type !== ChanType.QUERY) {
				return props.channel.messages;
			}

			if (store.state.settings.statusMessages === "hidden") {
				return props.channel.messages.filter(
					(message) => !condensedTypes.has(message.type || "")
				);
			}

			if (store.state.settings.statusMessages !== "condensed") {
				return props.channel.messages;
			}

			let lastCondensedContainer: CondensedMessageContainer | null = null;
			const condensed: (ClientMessage | CondensedMessageContainer)[] = [];

			for (const message of props.channel.messages) {
				if (message.self || message.highlight || !condensedTypes.has(message.type || "")) {
					lastCondensedContainer = null;
					condensed.push(message);
					continue;
				}

				if (!lastCondensedContainer) {
					lastCondensedContainer = {
						time: message.time,
						type: "condensed",
						messages: [],
					};
					condensed.push(lastCondensedContainer);
				}

				lastCondensedContainer.messages.push(message);
				lastCondensedContainer.id = message.id;

				if (message.id === props.channel.firstUnread) {
					lastCondensedContainer = null;
				}
			}

			return condensed.map((message) => {
				if (message.type === "condensed" && message.messages.length === 1) {
					return message.messages[0];
				}

				return message;
			});
		});

		// Windowed messages for rendering - show MAX_RENDERED_MESSAGES from windowStartIndex
		// This does NOT depend on scrolledToBottom to avoid reactivity issues
		// Index in allCondensedMessages of the first rendered entry: the
		// window start index, clamped to the valid range
		const renderStart = computed(() => {
			const total = allCondensedMessages.value.length;

			if (total <= MAX_RENDERED_MESSAGES) {
				return 0;
			}

			return Math.max(0, Math.min(windowStartIndex.value, total - MAX_RENDERED_MESSAGES));
		});

		const displayedMessages = computed(() => {
			const all = allCondensedMessages.value;

			if (all.length <= MAX_RENDERED_MESSAGES) {
				return all;
			}

			return all.slice(renderStart.value, renderStart.value + MAX_RENDERED_MESSAGES);
		});

		// Index in allCondensedMessages of the entry the unread marker goes in front of
		const unreadIndex = computed(() =>
			unreadMarkerIndex(allCondensedMessages.value, props.channel.firstUnread)
		);

		// Check if we can scroll further back in the window (not at start of all messages)
		const canScrollBack = computed(() => {
			return windowStartIndex.value > 0;
		});

		// Check if we're showing the latest messages
		const isAtEnd = computed(() => {
			const total = allCondensedMessages.value.length;
			return (
				total <= MAX_RENDERED_MESSAGES ||
				windowStartIndex.value >= total - MAX_RENDERED_MESSAGES
			);
		});

		// Should we show the "load more" button?
		// Only show when at the start of all loaded messages AND server has more
		const showLoadMoreButton = computed(() => {
			return props.channel.moreHistoryAvailable && windowStartIndex.value === 0;
		});

		// Only while looking at a slice of old history, at the end of what is loaded of it
		const showLoadNewerButton = computed(() => {
			return Boolean(props.channel.historySlice?.hasNewer) && isAtEnd.value;
		});

		// Helper to get a unique key for each message
		const getMessageKey = (message: ClientMessage | CondensedMessageContainer) => {
			if (message.type === "condensed") {
				return `condensed-${message.messages[0]?.id}-${new Date(message.time).getTime()}`;
			}

			// Use time as part of key since IDs can be inconsistent
			return `${message.id}-${new Date(message.time).getTime()}`;
		};

		const isMessageFocused = (message: ClientMessage | CondensedMessageContainer): boolean => {
			return focusedKey.value !== null && getMessageKey(message) === focusedKey.value;
		};

		// Scroll to bottom of the current DOM
		const scrollToBottom = () => {
			if (chat.value) {
				isScrolling.value = true;
				chat.value.scrollTop = chat.value.scrollHeight;

				// Reset after a short delay to allow the scroll event to fire
				setTimeout(() => {
					isScrolling.value = false;
				}, 50);
			}
		};

		// Keeps the newest message in view as messages arrive, once per frame:
		// reading scrollHeight forces a layout of the page, and doing that for
		// every message of a busy channel kept the browser busy. In a frame
		// callback the browser lays out the page for drawing anyway.
		// Rows scrolled into view are drawn a frame later and can turn out
		// taller than their placeholder, so it keeps looking until the bottom
		// has held still for a few frames.
		let followFrame = 0;

		const followNewest = (budget = 30, still = 0) => {
			if (followFrame) {
				return;
			}

			followFrame = requestAnimationFrame(() => {
				followFrame = 0;
				const el = chat.value;

				if (!el || !props.channel.scrolledToBottom) {
					return;
				}

				const behind = el.scrollHeight - el.scrollTop - el.clientHeight > 1;

				if (behind) {
					scrollToBottom();
				}

				const stillFrames = behind ? 0 : still + 1;

				if (stillFrames < 3 && budget > 1) {
					followNewest(budget - 1, stillFrames);
				}
			});
		};

		// When the person last scrolled the list themselves (wheel, touch,
		// scroll keys, dragging the scrollbar). Only then does moving away from
		// the bottom stop following new messages: rows growing once drawn, or
		// the oldest rows being dropped, move the view without anyone asking.
		let userScrolledAt = 0;
		const USER_SCROLL_MS = 1500;
		const SCROLL_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"]);

		const markUserScroll = (e: Event) => {
			if (e instanceof KeyboardEvent) {
				const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea");

				// Page keys scroll the list even from the input (keybinds.ts)
				if (!SCROLL_KEYS.has(e.key) || (typing && !e.key.startsWith("Page"))) {
					return;
				}
			}

			userScrolledAt = performance.now();
		};

		const userScrollEvents = ["wheel", "touchmove", "mousedown"] as const;

		const timeOf = (message: {time: Date | string | number}) =>
			new Date(message.time).getTime();

		// `last` is the oldest message the client holds in this channel,
		// nothing to ask for the newest page
		const requestHistory = (last?: {id: number; time: Date | string | number}) => {
			const oldest = props.channel.messages[0];

			props.channel.historyLoading = true;
			socket.emit("more", {
				target: props.channel.id,
				lastId: last ? last.id : -1,
				lastTime: last ? timeOf(last) : undefined,
				condensed: store.state.settings.statusMessages !== "shown",
				// Lets the server keep paging from storage once this
				// message is no longer in its memory
				beforeTime: oldest ? timeOf(oldest) : undefined,
			});
		};

		// Jump to the absolute bottom (latest messages) and mark as at bottom
		const jumpToBottom = async () => {
			stopHolding?.();
			cancelPendingJump(props.channel.id);
			pendingJump = null;
			jumping.value = false;
			props.channel.scrolledToBottom = true;

			if (props.channel.historySlice) {
				// The loaded messages are a slice of the past, the latest ones
				// have to come from the server. The list scrolls down by
				// itself once they arrive.
				leaveHistorySlice(props.channel);
				windowStartIndex.value = 0;
				requestHistory();
				return;
			}

			const total = allCondensedMessages.value.length;
			windowStartIndex.value = Math.max(0, total - MAX_RENDERED_MESSAGES);
			isAdjustingWindow.value = true;
			await nextTick();
			scrollToBottom();
			isAdjustingWindow.value = false;
			followNewest();
		};

		// Runs `change` (which moves the rendered window or the messages in
		// it) and keeps the entry at the top of the view where it was on
		// screen. The rendered window has a fixed size, so the height of
		// the list says nothing about how far its content moved.
		const keepViewInPlace = async (change: () => void) => {
			const el = chat.value;

			if (!el) {
				change();
				return;
			}

			const viewTop = el.getBoundingClientRect().top;
			const rows = el.querySelectorAll<HTMLElement>(".messages > .msg");
			let anchor: HTMLElement | null = null;

			for (const row of rows) {
				if (row.getBoundingClientRect().bottom > viewTop) {
					anchor = row;
					break;
				}
			}

			const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
			const oldScrollTop = el.scrollTop;
			const oldScrollHeight = el.scrollHeight;

			isAdjustingWindow.value = true;
			change();
			await nextTick();

			isScrolling.value = true;

			if (anchor?.isConnected) {
				setScrollTop(el, el.scrollTop + anchor.getBoundingClientRect().top - anchorTop);
			} else {
				setScrollTop(el, oldScrollTop + el.scrollHeight - oldScrollHeight);
			}

			setTimeout(() => {
				isScrolling.value = false;
				isAdjustingWindow.value = false;

				// At the very edge no scroll event comes to move the window
				// further, check right away
				syncScrollState();
			}, 50);
		};

		// Shift window up (show older messages) while preserving scroll position
		const shiftWindowUp = async (amount: number = 100) => {
			if (isAdjustingWindow.value || windowStartIndex.value <= 0) return;

			const newStart = Math.max(0, windowStartIndex.value - amount);

			await keepViewInPlace(() => {
				windowStartIndex.value = newStart;
				props.channel.scrolledToBottom = false;
			});
		};

		// Shift window down (show newer messages) while preserving scroll position
		const shiftWindowDown = async (amount: number = 100) => {
			if (isAdjustingWindow.value) return;

			const total = allCondensedMessages.value.length;
			const maxStart = Math.max(0, total - MAX_RENDERED_MESSAGES);
			if (windowStartIndex.value >= maxStart) return;

			const newStart = Math.min(maxStart, windowStartIndex.value + amount);

			await keepViewInPlace(() => {
				windowStartIndex.value = newStart;
			});
		};

		// Index, in the full list, of the entry that holds the jump target.
		// Id and time together identify a message. An id on its own is only
		// trusted when no time was given: ids restart with the server, so in
		// older history the same id shows up more than once.
		const findTargetIndex = (target: JumpTarget): number => {
			const all = allCondensedMessages.value;
			let sameId = -1;
			let closest = -1;
			let closestDistance = 1000; // time-only targets may be off by under a second

			for (let i = 0; i < all.length; i++) {
				const entry = all[i];
				const inner = entry.type === "condensed" ? entry.messages : [entry];

				for (const message of inner) {
					const time = timeOf(message);

					if (target.id !== null && message.id === target.id) {
						if (target.time === null || time === target.time) {
							return i;
						}

						if (sameId === -1) {
							sameId = i;
						}
					}

					if (target.id === null && target.time !== null) {
						const distance = Math.abs(time - target.time);

						if (distance < closestDistance) {
							closest = i;
							closestDistance = distance;
						}
					}
				}
			}

			if (target.id === null) {
				return closest;
			}

			// Without a time to check against, the id is all there is to go on
			return target.time === null ? sameId : -1;
		};

		// Puts `el` in the middle of the view and keeps it there while the
		// page settles. Late changes in height (previews and images loading,
		// history being added) would otherwise push the target away again
		// right after the jump. Any input from the user ends it at once.
		const holdInView = (el: HTMLElement) => {
			const container = chat.value;

			if (!container) {
				return;
			}

			const center = () => {
				el.scrollIntoView({behavior: "instant", block: "center"});

				// BUGBUG: prevent the chat window offset bugging when scrolling to items near the bottom of the chat
				const outer = container.closest("#chat-container");

				if (outer) {
					outer.scrollTop = 0;
				}
			};

			const userEvents = ["wheel", "touchstart", "mousedown", "keydown"];
			const resizeObserver = new ResizeObserver(center);
			const content = container.querySelector(".messages");

			let timer: ReturnType<typeof setTimeout> | undefined = undefined;

			const stop = () => {
				clearTimeout(timer);
				resizeObserver.disconnect();
				userEvents.forEach((name) => container.removeEventListener(name, stop));
				stopHolding = null;
				jumping.value = false;
				isScrolling.value = false;
				isAdjustingWindow.value = false;

				// Scroll events were ignored meanwhile, catch up with where
				// the view ended up
				syncScrollState();
			};

			timer = setTimeout(stop, JUMP_HOLD_MS);
			userEvents.forEach((name) => container.addEventListener(name, stop, {passive: true}));

			if (content) {
				resizeObserver.observe(content);
			}

			stopHolding = stop;
			isScrolling.value = true;
			center();
		};

		// Scrolls to a message and highlights it. A message that isn't loaded
		// is asked for from the server once (it sends the history around
		// it), and the jump is finished when that arrives.
		const jumpTo = async (target: JumpTarget, mayFetch = true): Promise<boolean> => {
			stopHolding?.();
			cancelPendingJump(props.channel.id);
			pendingJump = null;
			jumping.value = true;
			props.channel.scrolledToBottom = false;

			const index = findTargetIndex(target);

			if (index === -1) {
				if (mayFetch && target.time !== null && store.state.isConnected) {
					pendingJump = target;
					// Given up on timeout or disconnect
					startPendingJump(props.channel, target.time, () => {
						if (pendingJump === target) {
							pendingJump = null;
							jumping.value = false;
						}
					});
					socket.emit("messages:around", {target: props.channel.id, time: target.time});
				} else {
					jumping.value = false;
				}

				return false;
			}

			const all = allCondensedMessages.value;
			const key = getMessageKey(all[index]);
			focusedKey.value = key;
			isAdjustingWindow.value = true;

			// Adjust window to include the target message (center it if possible)
			windowStartIndex.value = Math.max(
				0,
				Math.min(
					index - Math.floor(MAX_RENDERED_MESSAGES / 2),
					all.length - MAX_RENDERED_MESSAGES
				)
			);

			await nextTick();

			// The entry itself, not `#msg-<id>`: a message inside a collapsed
			// group of status messages has no box to scroll to
			const el = chat.value?.querySelector<HTMLElement>(".messages > .msg.is-focused");

			if (!el) {
				focusedKey.value = null;
				jumping.value = false;
				isAdjustingWindow.value = false;
				return false;
			}

			holdInView(el);

			// Clear highlight after a few seconds
			setTimeout(() => {
				if (focusedKey.value === key) {
					focusedKey.value = null;
				}
			}, 3000);

			return true;
		};

		// The message the route asks to be shown, if any
		const routeTarget = (): JumpTarget | null => {
			const id = props.isFocused && !isNaN(props.isFocused) ? props.isFocused : null;
			const time = props.focusedTime && !isNaN(props.focusedTime) ? props.focusedTime : null;

			return id === null && time === null ? null : {id, time};
		};

		// The history around a jump target has arrived, finish the jump
		const onMessagesAround = (chanId: number) => {
			if (chanId !== props.channel.id || !pendingJump) {
				return;
			}

			const target = pendingJump;
			void nextTick().then(() => jumpTo(target, false));
		};

		// Load more from server
		const onShowMoreClick = () => {
			// The button is only disabled once the page re-renders, a second
			// press before that would ask for the same page again
			if (!store.state.isConnected || props.channel.historyLoading) return;

			requestHistory(props.channel.messages.find((message) => !message.showInActive));
		};

		// Where the list was at the last scroll event, to tell which way it moved
		let lastScrollTop = 0;

		// Asks for older history before the user reaches the top, see
		// PREFETCH_ENTRIES. Only while they scroll up themselves, and not
		// within the cooldown after a page: a page added above a coasting
		// touch scroll can take over the view (see setScrollTop).
		const prefetchOlder = (distanceFromTop: number, clientHeight: number) => {
			if (
				!props.channel.moreHistoryAvailable ||
				props.channel.historyLoading ||
				Date.now() - olderPageArrivedAt < AUTO_LOAD_COOLDOWN_MS
			) {
				return;
			}

			const near =
				windowStartIndex.value > 0
					? windowStartIndex.value < PREFETCH_ENTRIES
					: distanceFromTop < clientHeight * PREFETCH_SCREENS;

			if (near) {
				onShowMoreClick();
			}
		};

		// Handle scroll events - triggers window shifting when near edges
		const handleScroll = () => {
			const el = chat.value;
			if (!el) return;

			const scrolledUp = el.scrollTop < lastScrollTop;
			lastScrollTop = el.scrollTop;

			// Skip if we're doing a programmatic scroll or adjusting the window
			if (isScrolling.value || isAdjustingWindow.value || jumping.value) {
				return;
			}

			const scrollTop = el.scrollTop;
			const scrollHeight = el.scrollHeight;
			const clientHeight = el.clientHeight;
			const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
			const distanceFromTop = scrollTop;

			// Update scrolledToBottom state - only when actually at the DOM bottom AND at end of messages
			const atDOMBottom = distanceFromBottom <= 30;

			// The end of a history slice is not the present
			if (atDOMBottom && isAtEnd.value && !props.channel.historySlice) {
				if (!props.channel.scrolledToBottom) {
					props.channel.scrolledToBottom = true;
				}
			} else if (
				props.channel.scrolledToBottom &&
				distanceFromBottom > 100 &&
				performance.now() - userScrolledAt < USER_SCROLL_MS
			) {
				// Only unset if user scrolled significantly away from bottom
				props.channel.scrolledToBottom = false;
			}

			if (scrolledUp && performance.now() - userScrolledAt < USER_SCROLL_MS) {
				prefetchOlder(distanceFromTop, clientHeight);
			}

			// Dynamic window shifting - shift when user scrolls near edges
			// Shift up (load older) when near top and there are more messages above
			if (distanceFromTop < SCROLL_THRESHOLD && canScrollBack.value) {
				void shiftWindowUp(50);
			}
			// Shift down (load newer) when near bottom but not at end
			else if (distanceFromBottom < SCROLL_THRESHOLD && !isAtEnd.value) {
				void shiftWindowDown(50);
			}
		};

		// Extend a slice of old history towards the present
		const onShowNewerClick = () => {
			const slice = props.channel.historySlice;
			const newest = props.channel.messages[props.channel.messages.length - 1];

			if (!slice || slice.loadingNewer || !newest || !store.state.isConnected) {
				return;
			}

			slice.loadingNewer = true;
			// Whatever arrived live up to now is in storage and comes with this page
			slice.liveDropped = false;
			socket.emit("messages:after", {target: props.channel.id, afterTime: timeOf(newest)});
		};

		// `idx` is the index among the rendered entries; markers depend on the
		// entry before it in the full list, which may not be rendered
		const shouldDisplayDateMarker = (idx: number) =>
			startsNewDay(allCondensedMessages.value, renderStart.value + idx);

		const shouldDisplayUnreadMarker = (idx: number) =>
			renderStart.value + idx === unreadIndex.value;

		const isPreviousSource = (currentMessage: ClientMessage, idx: number) => {
			const previousMessage = displayedMessages.value[idx - 1];
			return (
				previousMessage &&
				currentMessage.type === MessageType.MESSAGE &&
				previousMessage.type === MessageType.MESSAGE &&
				currentMessage.from &&
				previousMessage.from &&
				currentMessage.from.nick === previousMessage.from.nick
			);
		};

		const onCopy = () => {
			if (chat.value) {
				clipboard(chat.value);
			}
		};

		// Called when something in the list changes height: a link preview
		// loading or being toggled, a group of status messages expanding, the
		// input growing. Only the bottom has to be held on to; a change above
		// the view is compensated by the browser's scroll anchoring, and one
		// below it doesn't move what is being read.
		const keepScrollPosition = async () => {
			if (!props.channel.scrolledToBottom) {
				return;
			}

			await nextTick();
			followNewest();
		};

		const onLinkPreviewToggle = async (preview: ClientLinkPreview, message: ClientMessage) => {
			await keepScrollPosition();
			socket.emit("msg:preview:toggle", {
				target: props.channel.id,
				msgId: message.id,
				link: preview.link,
				shown: preview.shown,
			});
		};

		const handleResize = () => {
			if (props.channel.scrolledToBottom) {
				void jumpToBottom();
			}
		};

		syncScrollState = handleScroll;

		// Observing a button again reports whether it is in view right now
		const recheckButton = (button: HTMLButtonElement | null) => {
			if (button && historyObserver.value) {
				historyObserver.value.unobserve(button);
				historyObserver.value.observe(button);
			}
		};

		// Presses the "show older" / "show newer" buttons for the user as soon
		// as they scroll into view. A disabled button ignores the press, which
		// is what keeps a page from being requested twice.
		const observeHistoryButtons = () => {
			if (!window.IntersectionObserver || !chat.value) {
				return;
			}

			if (!historyObserver.value) {
				historyObserver.value = new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							if (!entry.isIntersecting) {
								continue;
							}

							const button = entry.target as HTMLButtonElement;

							if (button === loadMoreButton.value) {
								const wait =
									olderPageArrivedAt + AUTO_LOAD_COOLDOWN_MS - Date.now();

								if (wait > 0) {
									// Still in view once the cooldown is over: load then
									clearTimeout(autoLoadRecheck);
									autoLoadRecheck = setTimeout(
										() => recheckButton(loadMoreButton.value),
										wait
									);
									continue;
								}
							}

							button.click();
						}
					},
					{root: chat.value}
				);
			}

			recheckButton(loadMoreButton.value);
			recheckButton(loadNewerButton.value);
		};

		watch(
			() => props.channel.historyLoading,
			(loading, wasLoading) => {
				if (wasLoading && !loading) {
					olderPageArrivedAt = Date.now();
				}
			}
		);

		// Initialize
		onMounted(async () => {
			chat.value?.addEventListener("scroll", handleScroll, {passive: true});
			chat.value?.addEventListener("touchstart", onTouchStart, {passive: true});
			chat.value?.addEventListener("touchend", onTouchEnd, {passive: true});
			chat.value?.addEventListener("touchcancel", onTouchEnd, {passive: true});
			userScrollEvents.forEach((name) =>
				chat.value?.addEventListener(name, markUserScroll, {passive: true})
			);
			window.addEventListener("keydown", markUserScroll, {capture: true, passive: true});
			eventbus.on("resize", handleResize);
			eventbus.on("messages:around", onMessagesAround);

			const target = routeTarget();

			if (target) {
				// Handle initial focus from search
				await nextTick();
				await jumpTo(target);
			} else {
				// Default: scroll to bottom
				props.channel.scrolledToBottom = true;
				windowStartIndex.value = Math.max(
					0,
					allCondensedMessages.value.length - MAX_RENDERED_MESSAGES
				);
				await nextTick();
				scrollToBottom();
				followNewest();
			}

			// Set up intersection observer for auto-loading history
			await nextTick();
			observeHistoryButtons();
		});

		// Channel switch - scroll to bottom and reset window
		watch(
			() => props.channel.id,
			async (_id, oldId) => {
				stopHolding?.();
				// Its answer must not land in the channel that was left
				cancelPendingJump(oldId);
				pendingJump = null;
				focusedKey.value = null;

				if (routeTarget()) {
					// Switched straight to a message in this channel, the
					// watcher on the route's target takes it from here
					observeHistoryButtons();
					return;
				}

				jumping.value = false;
				props.channel.scrolledToBottom = true;
				windowStartIndex.value = Math.max(
					0,
					allCondensedMessages.value.length - MAX_RENDERED_MESSAGES
				);
				await nextTick();
				scrollToBottom();
				followNewest();
				observeHistoryButtons();
			}
		);

		// Messages were added in front (older history) or dropped from the
		// front (the client trims what it holds in memory)
		watch(
			() => ({
				chanId: props.channel.id,
				first: props.channel.messages[0],
			}),
			async (now, before) => {
				if (
					now.chanId !== before.chanId ||
					!now.first ||
					!before.first ||
					now.first === before.first
				) {
					return;
				}

				// A jump puts the view where it belongs by itself
				if (jumping.value) return;

				if (props.channel.scrolledToBottom) {
					// Stay with the newest messages, as when they are added
					windowStartIndex.value = Math.max(
						0,
						allCondensedMessages.value.length - MAX_RENDERED_MESSAGES
					);
					followNewest();
					return;
				}

				const all = allCondensedMessages.value;
				const maxStart = Math.max(0, all.length - MAX_RENDERED_MESSAGES);

				// Keep rendering the same entries: they moved down by the
				// number of entries made up only of the messages added in front
				const addedCount = props.channel.messages.indexOf(before.first);
				let shift = 0;

				if (addedCount > 0) {
					const added = new Set(props.channel.messages.slice(0, addedCount));

					for (const entry of all) {
						const last =
							entry.type === "condensed"
								? entry.messages[entry.messages.length - 1]
								: entry;

						if (!added.has(last)) break;
						shift++;
					}
				}

				await keepViewInPlace(() => {
					windowStartIndex.value = Math.min(maxStart, windowStartIndex.value + shift);
				});
			}
		);

		// New messages at the end - stay at bottom if we were at bottom
		watch(
			() => props.channel.messages.length,
			async (newLen, oldLen) => {
				if (props.channel.scrolledToBottom) {
					// Keep window at the end when new messages come in
					const total = allCondensedMessages.value.length;
					windowStartIndex.value = Math.max(0, total - MAX_RENDERED_MESSAGES);
					followNewest();
				} else if (oldLen !== undefined && newLen > oldLen) {
					// Messages were added at the end while the user reads older
					// ones: leave the view alone, but if it is at the end of the
					// rendered window ("show newer" in a history slice) extend
					// the window, as no scroll event may come to do it
					await nextTick();
					syncScrollState();
				}
			}
		);

		// Keep the newest message in view while the input grows with what is typed
		watch(
			() => props.channel.pendingMessage,
			() => keepScrollPosition()
		);

		// Jump to the message the route points at (from search results or mentions)
		watch(
			() => [props.isFocused, props.focusedTime],
			async () => {
				const target = routeTarget();

				if (!target) return;

				await nextTick();
				await jumpTo(target);
			}
		);

		onBeforeUnmount(() => {
			cancelAnimationFrame(followFrame);

			stopHolding?.();
			cancelPendingJump(props.channel.id);
			eventbus.off("resize", handleResize);
			eventbus.off("messages:around", onMessagesAround);
			chat.value?.removeEventListener("scroll", handleScroll);
			chat.value?.removeEventListener("touchstart", onTouchStart);
			chat.value?.removeEventListener("touchend", onTouchEnd);
			chat.value?.removeEventListener("touchcancel", onTouchEnd);
			clearTimeout(autoLoadRecheck);
			userScrollEvents.forEach((name) =>
				chat.value?.removeEventListener(name, markUserScroll)
			);
			window.removeEventListener("keydown", markUserScroll, {capture: true});
		});

		onUnmounted(() => {
			historyObserver.value?.disconnect();
		});

		return {
			chat,
			store,
			loadMoreButton,
			loadNewerButton,
			showLoadNewerButton,
			onShowNewerClick,
			displayedMessages,
			showLoadMoreButton,
			getMessageKey,
			isMessageFocused,
			onShowMoreClick,
			onCopy,
			shouldDisplayDateMarker,
			shouldDisplayUnreadMarker,
			keepScrollPosition,
			isPreviousSource,
			jumpToBottom,
			onLinkPreviewToggle,
		};
	},
});
</script>
