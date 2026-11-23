import {expect} from "chai";
import {mount} from "@vue/test-utils";
import DateMarker from "../../../client/components/DateMarker.vue";
import eventbus from "../../../client/js/eventbus.js";
import type {ClientMessage} from "../../../client/js/types.js";

function label(time: Date) {
	const wrapper = mount(DateMarker, {props: {message: {time} as unknown as ClientMessage}});
	return wrapper;
}

function text(wrapper: ReturnType<typeof label>) {
	return wrapper.find(".date-marker-text").attributes("aria-label");
}

describe("DateMarker", function () {
	it("labels today's and yesterday's messages", function () {
		const yesterday = new Date();
		yesterday.setDate(yesterday.getDate() - 1);

		expect(text(label(new Date()))).to.equal("Today");
		expect(text(label(yesterday))).to.equal("Yesterday");
	});

	it("calls a message stamped just past midnight tomorrow 'Today'", function () {
		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		tomorrow.setHours(0, 0, 5, 0);

		expect(text(label(tomorrow))).to.equal("Today");
	});

	it("updates the label when the day changes", async function () {
		const time = new Date();
		const wrapper = label(time);
		expect(text(wrapper)).to.equal("Today");

		// Pretend a day has passed: the message is now a day old.
		time.setDate(time.getDate() - 1);
		eventbus.emit("daychange");
		await wrapper.vm.$nextTick();

		expect(text(wrapper)).to.equal("Yesterday");
		wrapper.unmount();
	});
});
