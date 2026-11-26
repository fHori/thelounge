import {IrcEventHandler} from "../../client.js";
import {READ_MARKER_CAP, applyReadMarker, requestReadMarker} from "../readMarker.js";

const TIMESTAMP_PREFIX = "timestamp=";

export default <IrcEventHandler>function (irc, network) {
	// Format: MARKREAD <target> timestamp=YYYY-MM-DDThh:mm:ss.sssZ
	// or MARKREAD <target> * when nothing in the buffer was read yet
	irc.on("unknown command", (command) => {
		if (command.command !== "MARKREAD") {
			return;
		}

		const target = command.params[0];
		const param = command.params[1];

		if (!target || !param || !param.startsWith(TIMESTAMP_PREFIX)) {
			return;
		}

		const time = Date.parse(param.slice(TIMESTAMP_PREFIX.length));

		if (Number.isNaN(time)) {
			return;
		}

		const chan = network.getChannel(target);

		if (!chan) {
			return;
		}

		applyReadMarker(this, chan, time);
	});

	// The server sends the marker of a channel when it is joined,
	// the one of a private conversation has to be asked for.
	irc.on("registered", () => {
		if (!irc.network.cap.isEnabled(READ_MARKER_CAP)) {
			return;
		}

		network.channels.forEach((chan) => requestReadMarker(network, chan));
	});
};
