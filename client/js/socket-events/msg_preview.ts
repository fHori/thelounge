import {toRaw} from "vue";
import socket from "../socket";
import {store} from "../store";

socket.on("msg:preview", function (data) {
	const netChan = store.getters.findChannel(data.chan);
	// Previews come right after their message, so look from the newest
	const messages = netChan ? toRaw(netChan.channel.messages) : [];
	let message: (typeof messages)[number] | undefined;

	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].id === data.id) {
			message = messages[i];
			break;
		}
	}

	if (!message || !message.previews) {
		return;
	}

	const previewIndex = message.previews.findIndex((m) => m.link === data.preview.link);

	if (previewIndex > -1) {
		message.previews[previewIndex] = data.preview;
	}
});
