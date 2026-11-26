import Msg from "../models/msg.js";
import Chan from "../models/chan.js";
import Client from "../client.js";
import Network from "../models/network.js";
import Config from "../config.js";
import log from "../log.js";
import {MessageType, MassEventSummary} from "../../shared/types/msg.js";
import {condensedTypes} from "../../shared/irc.js";
import {messageKey} from "../../shared/messageKey.js";

// The most messages one summary stands for. Their keys are held in memory
// for as long as the summary is, so a longer flood is split into several
// summaries instead.
export const maxCapturedPerSummary = 5000;

type SummaryCounts = Omit<MassEventSummary, "duration" | "startTime" | "endTime">;

interface ChannelMassEventState {
	isActive: boolean;
	// Counts of the messages captured since activation
	counts: SummaryCounts;
	// Keys (see messageKey) of the messages captured since activation
	captured: Set<string>;
	// Earliest and latest `time` of the captured messages
	firstTime: number | null;
	lastTime: number | null;
	cooldownTimer: ReturnType<typeof setTimeout> | null;
	maxDurationTimer: ReturnType<typeof setTimeout> | null;
	recentTimestamps: number[];
}

function emptyCounts(): SummaryCounts {
	return {
		joins: 0,
		parts: 0,
		quits: 0,
		modes: 0,
		nicks: 0,
		kicks: 0,
		chghosts: 0,
		away: 0,
		back: 0,
	};
}

/**
 * Aggregates floods of join/part/quit/mode/... messages (netsplits, reconnects)
 * into a single summary message.
 *
 * While a mass event is active, captured messages are not sent to the browser
 * and not held in the channel's in-memory history; the live view gets one
 * MASS_EVENT summary when the event ends. They are still written to message
 * storage straight away, so stored history stays complete. The summary itself
 * is not stored (see Msg.isLoggable), as it only describes rows that are.
 *
 * Code that merges stored rows into in-memory history has to skip the rows a
 * held summary already stands for, see coveredByMassEvent().
 */
class MassEventAggregator {
	private channelStates: Map<number, ChannelMassEventState> = new Map();
	// The keys of the messages each summary stands for. Held only as long
	// as the summary itself is (in a channel's in-memory history).
	private summaryKeys = new WeakMap<Msg, ReadonlySet<string>>();
	private client: Client;

	constructor(client: Client) {
		this.client = client;
	}

	private getOrCreateState(chanId: number): ChannelMassEventState {
		let state = this.channelStates.get(chanId);

		if (!state) {
			state = {
				isActive: false,
				counts: emptyCounts(),
				captured: new Set(),
				firstTime: null,
				lastTime: null,
				cooldownTimer: null,
				maxDurationTimer: null,
				recentTimestamps: [],
			};
			this.channelStates.set(chanId, state);
		}

		return state;
	}

	/**
	 * Process an incoming status message.
	 * Returns true if the message was captured (mass event active): it has been
	 * written to message storage and will be part of the summary, the caller
	 * must not push it to the channel.
	 * Returns false if the message should be sent normally.
	 */
	processMessage(
		network: Network,
		chan: Chan,
		msg: Msg,
		userUpdateCallback?: () => void
	): boolean {
		// Check if mass event detection is enabled
		if (!Config.values.massEventDetection?.enable) {
			return false;
		}

		// Only process condensable message types
		if (!condensedTypes.has(msg.type)) {
			return false;
		}

		// Never buffer self messages or highlights
		if (msg.self || msg.highlight) {
			return false;
		}

		const config = Config.values.massEventDetection;
		const state = this.getOrCreateState(chan.id);
		const now = Date.now();

		if (!state.isActive) {
			// Update recent timestamps (sliding window)
			const windowStart = now - config.windowMs;
			state.recentTimestamps = state.recentTimestamps.filter((t) => t > windowStart);
			state.recentTimestamps.push(now);

			if (state.recentTimestamps.length < config.threshold) {
				return false; // Not in mass event mode, process normally
			}

			// The messages before this one were already sent normally, so they
			// are not part of the summary. Capturing starts with this one.
			log.debug(
				`MassEvent: ACTIVATING for ${chan.name} (${state.recentTimestamps.length} msgs)`
			);

			state.recentTimestamps = [];
			this.activateMassEvent(state, chan, network);
		} else if (state.captured.size >= maxCapturedPerSummary) {
			// Bounds the keys a summary holds on to: carry on with a new one
			this.endMassEvent(state, chan, network);
			this.activateMassEvent(state, chan, network);
		}

		this.capture(state, chan, msg);

		// Execute user update callback (for real-time user list updates)
		if (userUpdateCallback) {
			userUpdateCallback();
		}

		// Reset cooldown timer
		this.resetCooldownTimer(state, chan, network);

		return true;
	}

	/**
	 * Returns a check for whether a stored message is already represented by a
	 * mass event summary held in the channel's memory (or by the mass event in
	 * progress), so it must not be added to the in-memory history next to it.
	 *
	 * Only the messages that were actually captured match, by id and time:
	 * message times come from the IRC server and say nothing about which
	 * messages a summary stands for.
	 */
	coveredByMassEvent(chan: Chan): (msg: Msg) => boolean {
		const sets: ReadonlySet<string>[] = [];

		for (const held of chan.messages) {
			const keys = held.type === MessageType.MASS_EVENT && this.summaryKeys.get(held);

			if (keys) {
				sets.push(keys);
			}
		}

		const state = this.channelStates.get(chan.id);

		if (state?.isActive && state.captured.size > 0) {
			sets.push(state.captured);
		}

		return (msg) => {
			if (sets.length === 0 || !condensedTypes.has(msg.type)) {
				return false;
			}

			const key = messageKey(msg);
			return sets.some((keys) => keys.has(key));
		};
	}

	private capture(state: ChannelMassEventState, chan: Chan, msg: Msg) {
		this.count(state.counts, msg);

		const time = new Date(msg.time).getTime();
		state.firstTime = state.firstTime === null ? time : Math.min(state.firstTime, time);
		state.lastTime = state.lastTime === null ? time : Math.max(state.lastTime, time);

		// Keep the individual message in stored history. It gets an id like
		// every other message so it can be told apart from them.
		msg.id = this.client.idMsg++;
		state.captured.add(messageKey(msg));

		if (!Config.values.public) {
			chan.storeMessage(this.client, msg);
		}
	}

	private activateMassEvent(state: ChannelMassEventState, chan: Chan, network: Network): void {
		state.isActive = true;

		const config = Config.values.massEventDetection;

		// Set maximum duration timer
		state.maxDurationTimer = setTimeout(() => {
			this.endMassEvent(state, chan, network);
		}, config.maxDurationMs);
	}

	private resetCooldownTimer(state: ChannelMassEventState, chan: Chan, network: Network): void {
		if (state.cooldownTimer) {
			clearTimeout(state.cooldownTimer);
		}

		const config = Config.values.massEventDetection;

		state.cooldownTimer = setTimeout(() => {
			this.endMassEvent(state, chan, network);
		}, config.cooldownMs);
	}

	private clearTimers(state: ChannelMassEventState) {
		if (state.cooldownTimer) {
			clearTimeout(state.cooldownTimer);
			state.cooldownTimer = null;
		}

		if (state.maxDurationTimer) {
			clearTimeout(state.maxDurationTimer);
			state.maxDurationTimer = null;
		}
	}

	private endMassEvent(state: ChannelMassEventState, chan: Chan, network: Network): void {
		if (!state.isActive) {
			return;
		}

		this.clearTimers(state);

		const now = Date.now();
		const captured = state.captured;
		const startTime = state.firstTime ?? now;
		const endTime = state.lastTime ?? now;

		// The time range is the one of the captured messages
		const summary: MassEventSummary = {
			...state.counts,
			duration: endTime - startTime,
			startTime: new Date(startTime),
			endTime: new Date(endTime),
		};

		log.debug(
			`MassEvent: ENDING for ${chan.name} - joins=${summary.joins} parts=${summary.parts} quits=${summary.quits}`
		);

		// Reset state
		state.isActive = false;
		state.counts = emptyCounts();
		state.captured = new Set();
		state.firstTime = null;
		state.lastTime = null;
		state.recentTimestamps = [];

		const summaryMsg = new Msg({
			type: MessageType.MASS_EVENT,
			time: new Date(now),
			localTime: true,
			massEventSummary: summary,
		});
		this.summaryKeys.set(summaryMsg, captured);

		// Push summary message through normal channel
		chan.pushMessage(this.client, summaryMsg);

		// Refresh user list if configured
		if (Config.values.massEventDetection.refreshNamesAfter && network.irc) {
			network.irc.raw("NAMES", chan.name);
		}
	}

	private count(counts: SummaryCounts, msg: Msg) {
		switch (msg.type) {
			case MessageType.JOIN:
				counts.joins++;
				break;
			case MessageType.PART:
				counts.parts++;
				break;
			case MessageType.QUIT:
				counts.quits++;
				break;

			case MessageType.MODE: {
				// Count individual mode changes
				const modeChanges = (msg.text || "")
					.split(" ")[0]
					.split("")
					.filter((c) => c !== "+" && c !== "-").length;
				counts.modes += modeChanges || 1;
				break;
			}

			case MessageType.NICK:
				counts.nicks++;
				break;
			case MessageType.KICK:
				counts.kicks++;
				break;
			case MessageType.CHGHOST:
				counts.chghosts++;
				break;
			case MessageType.AWAY:
				counts.away++;
				break;
			case MessageType.BACK:
				counts.back++;
				break;
		}
	}

	/**
	 * Drop the state and timers of a channel that is being removed (parted,
	 * closed, or its network removed). Captured messages are already stored.
	 */
	cleanup(chanId: number): void {
		const state = this.channelStates.get(chanId);

		if (state) {
			this.clearTimers(state);
			this.channelStates.delete(chanId);
		}
	}

	/**
	 * Check if mass event is active for a channel
	 */
	isActive(chanId: number): boolean {
		return this.channelStates.get(chanId)?.isActive || false;
	}
}

export default MassEventAggregator;
