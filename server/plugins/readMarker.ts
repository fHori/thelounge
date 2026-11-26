import _ from "lodash";
import type Client from "../client.js";
import type Chan from "../models/chan.js";
import type Network from "../models/network.js";
import {ChanType} from "../../shared/types/chan.js";
import {MessageType} from "../../shared/types/msg.js";

// IRCv3 draft/read-marker: the server keeps, per buffer, the time up to which
// the user has read, and shares it between all of their clients.
// https://ircv3.net/specs/extensions/read-marker
export const READ_MARKER_CAP = "draft/read-marker";

// Lines people read. The marker is taken from these only: they always carry
// the server's time, unlike lines made here, some of which were stored before
// they were told apart by `localTime`.
const READ_TYPES = new Set([MessageType.MESSAGE, MessageType.ACTION, MessageType.NOTICE]);

// A burst of messages into an open buffer (history playback, a busy channel)
// moves the marker once, not once per message.
const SEND_DELAY_MS = 1000;

const pendingSends = new WeakMap<Chan, NodeJS.Timeout>();

export function supportsReadMarker(network: Network, chan: Chan) {
	if (chan.type !== ChanType.CHANNEL && chan.type !== ChanType.QUERY) {
		return false;
	}

	return network.irc?.network?.cap?.isEnabled(READ_MARKER_CAP) === true;
}

// The server sends the marker of a channel when it is joined; the one of a
// private conversation has to be asked for, on connect and when one starts
export function requestReadMarker(network: Network, chan: Chan) {
	if (chan.type === ChanType.QUERY && supportsReadMarker(network, chan)) {
		network.irc!.raw("MARKREAD", chan.name);
	}
}

// A line the server says was read on this or another client
export function wasReadElsewhere(chan: Chan, msg: {time: Date; localTime?: boolean}) {
	return !msg.localTime && msg.time.getTime() <= chan.readMarker;
}

function isOpenInBrowser(client: Client, chan: Chan) {
	return _.find(client.attachedClients, {openChannel: chan.id}) !== undefined;
}

// Open in a browser tab that is on screen. A channel left open in a background
// tab is not being read, so it must not move the marker for the other clients.
function isBeingRead(client: Client, chan: Chan) {
	return _.some(
		client.attachedClients,
		(attached) => attached.openChannel === chan.id && attached.visible !== false
	);
}

// A browser tab came to the front or went to the background
export function setBrowserVisible(client: Client, socketId: string, visible: boolean) {
	const attached = client.attachedClients[socketId];

	if (!attached || (attached.visible !== false) === visible) {
		return;
	}

	attached.visible = visible;

	if (!visible) {
		return;
	}

	// What arrived while the tab was in the background is on screen now
	const target = client.find(attached.openChannel);

	if (target) {
		sendReadMarker(target.network, target.chan);
	}
}

// Tells the server everything currently in the buffer has been read
export function sendReadMarker(network: Network, chan: Chan) {
	if (!supportsReadMarker(network, chan)) {
		return;
	}

	// The marker has to be the `time` tag of a message. Lines stamped with our
	// own clock don't count: ones made here, and all of them without server-time.
	const last = _.findLast(chan.messages, (msg) => READ_TYPES.has(msg.type) && !msg.localTime);
	const time = last?.time?.getTime();

	// The marker only ever moves forward
	if (!last || !time || !(time > chan.readMarker)) {
		return;
	}

	chan.readMarker = time;
	network.irc!.raw("MARKREAD", chan.name, `timestamp=${last.time.toISOString()}`);
}

export function sendReadMarkerIfBeingRead(client: Client, network: Network, chan: Chan) {
	if (isBeingRead(client, chan)) {
		sendReadMarker(network, chan);
	}
}

// Same as sendReadMarker(), for messages arriving in a buffer that is being read
export function scheduleReadMarker(client: Client, network: Network, chan: Chan) {
	if (pendingSends.has(chan) || !supportsReadMarker(network, chan)) {
		return;
	}

	if (!isBeingRead(client, chan)) {
		return;
	}

	const timer = setTimeout(() => {
		pendingSends.delete(chan);

		// The buffer may have been left in the meantime, what arrived since is unread
		sendReadMarkerIfBeingRead(client, network, chan);
	}, SEND_DELAY_MS);

	timer.unref();
	pendingSends.set(chan, timer);
}

// The server reports the buffer was read up to `time`, on this or another client
export function applyReadMarker(client: Client, chan: Chan, time: number) {
	if (!(time > chan.readMarker)) {
		return;
	}

	chan.readMarker = time;

	// Nothing is unread in a buffer that is open here
	if (isOpenInBrowser(client, chan)) {
		return;
	}

	let unread = chan.unread;
	let highlight = chan.highlight;

	chan.trimUnreadLog();
	const stillUnread = chan.unreadLog.filter((entry) => entry.time > time);

	// Unread messages the log no longer holds are older than the ones it does:
	// read if any of those was, otherwise unknown and the counts stay
	if (chan.unreadLog.length === chan.unread || stillUnread.length < chan.unreadLog.length) {
		unread = stillUnread.length;
		highlight = Math.min(highlight, stillUnread.filter((entry) => entry.highlight).length);
		chan.unreadLog = stillUnread;
	}

	let lastRead = 0;

	for (const msg of chan.messages) {
		if (msg.time.getTime() <= time) {
			lastRead = msg.id;
		}
	}

	const firstUnread = Math.max(chan.firstUnread, lastRead);

	if (
		unread === chan.unread &&
		highlight === chan.highlight &&
		firstUnread === chan.firstUnread
	) {
		return;
	}

	chan.unread = unread;
	chan.highlight = highlight;
	chan.firstUnread = firstUnread;

	client.emit("channel:unread", {chan: chan.id, unread, highlight, firstUnread});
}
