import socket from "../socket";
import {store} from "../store";
import {switchToChannel} from "../router";
import {ChanType, SpecialChanType} from "../../../shared/types/chan";
import type {ClientNetwork} from "../types";

/** Runs /list on a network and opens its channel browser. */
export function browseChannels(network: ClientNetwork) {
	const findList = () =>
		network.channels.find(
			(c) => c.type === ChanType.SPECIAL && c.special === SpecialChanType.CHANNELLIST
		);

	socket.emit("input", {target: network.channels[0].id, text: "/list"});

	const existing = findList();

	if (existing) {
		switchToChannel(existing);
		return;
	}

	// The list window is created when the server starts answering
	const stop = store.watch(
		() => findList(),
		(list) => {
			if (list) {
				stop();
				switchToChannel(list);
			}
		}
	);
	setTimeout(stop, 10000);
}

/** Back to the conversation shown before (settings, help...), or the first network. */
export function backToConversation() {
	const last = store.state.lastActiveChannel;
	const found = last && store.getters.findChannel(last.channel.id);
	const target = found?.channel || store.state.networks[0]?.channels[0];

	if (target) {
		switchToChannel(target);
	}
}
