import {EventEmitter} from "events";
import {expect} from "chai";
import type Client from "../../../server/client.js";
import Chan from "../../../server/models/chan.js";
import Network from "../../../server/models/network.js";
import User from "../../../server/models/user.js";
import kick from "../../../server/plugins/irc-events/kick.js";
import {ChanState} from "../../../shared/types/chan.js";

function setup() {
	const irc = Object.assign(new EventEmitter(), {user: {nick: "me"}});
	const chan = new Chan({name: "#test", state: ChanState.JOINED});
	chan.setUser(new User({nick: "me"}));
	chan.setUser(new User({nick: "op"}));
	chan.setUser(new User({nick: "other"}));

	const network = new Network({host: "example.com", channels: [chan]});
	const emitted: {event: string; data: unknown}[] = [];
	const client = {
		idMsg: 1,
		attachedClients: {},
		messageStorage: [],
		emit(event: string, data: unknown) {
			emitted.push({event, data});
		},
	};

	kick.call(
		client as unknown as Client,
		irc as unknown as Parameters<typeof kick>[0],
		network as Parameters<typeof kick>[1]
	);

	return {irc, chan, emitted};
}

describe("kick event", function () {
	it("empties the user list and tells clients to refresh it when we are kicked", function () {
		const {irc, chan, emitted} = setup();

		irc.emit("kick", {channel: "#test", nick: "op", kicked: "me", message: "bye"});

		expect(chan.users.size).to.equal(0);
		expect(chan.state).to.equal(ChanState.PARTED);
		expect(emitted.map((e) => e.event)).to.include.members(["channel:state", "users"]);
		expect(emitted.find((e) => e.event === "users")?.data).to.deep.equal({chan: chan.id});
	});
});
