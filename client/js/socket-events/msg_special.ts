import socket from "../socket";
import {store} from "../store";
import {switchToChannel} from "../router";
import {isQuiet} from "../quietJoins";

socket.on("msg:special", function (data) {
	const netChan = store.getters.findChannel(data.chan);

	if (!netChan) {
		return;
	}

	netChan.channel.data = data.data;

	// A list Discover asked for: it shows there
	if (isQuiet(netChan.network.uuid, netChan.channel.name)) {
		return;
	}

	switchToChannel(netChan.channel);
});
