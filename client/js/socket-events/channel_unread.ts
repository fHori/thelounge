import socket from "../socket";
import {store} from "../store";

// The channel was read, fully or in part, on another IRC client
socket.on("channel:unread", function (data) {
	// Nothing is unread in the channel that is active on this client
	if (store.state.activeChannel && store.state.activeChannel.channel.id === data.chan) {
		return;
	}

	const netChan = store.getters.findChannel(data.chan);

	if (netChan?.channel) {
		netChan.channel.unread = data.unread;
		netChan.channel.highlight = data.highlight;
		netChan.channel.firstUnread = data.firstUnread;
	}
});
