import {expect} from "chai";
import {defineComponent, h, PropType} from "vue";
import {mount} from "@vue/test-utils";
// The sidebar components import each other in a cycle; load them in app order
import "../../../client/components/App.vue";
import DirectMessageSection from "../../../client/components/DirectMessageSection.vue";
import {store, key} from "../../../client/js/store.js";
import storage from "../../../client/js/localStorage.js";
import type {ClientChan, ClientNetwork} from "../../../client/js/types.js";

const ChannelStub = defineComponent({
	props: {channel: {type: Object as PropType<ClientChan>, required: true}},
	setup(props) {
		return () => h("div", {class: "dm-name"}, props.channel.name);
	},
});

let nextId = 1000;

function query(name: string, extra: Partial<ClientChan> = {}) {
	return {id: nextId++, name, type: "query", unread: 0, highlight: 0, ...extra} as ClientChan;
}

function setup(queries: ClientChan[], collapsed: boolean) {
	const network = {uuid: "dm-test-net", isCollapsed: false, channels: queries} as ClientNetwork;
	storage.set(
		"thelounge.directMessages.collapsed",
		JSON.stringify(collapsed ? [network.uuid + "-dms"] : [])
	);

	const wrapper = mount(DirectMessageSection, {
		props: {network, queries},
		global: {plugins: [[store, key]], stubs: {Channel: ChannelStub}},
	});

	const names = () => wrapper.findAll(".dm-name").map((w) => w.text());

	const open = async (chan?: ClientChan) => {
		store.commit("activeChannel", chan ? {network, channel: chan} : undefined);
		await wrapper.vm.$nextTick();
	};

	return {wrapper, names, open};
}

describe("DirectMessageSection", function () {
	afterEach(function () {
		store.commit("activeChannel", undefined);
		storage.remove("thelounge.directMessages.collapsed");
	});

	it("shows the open DM while collapsed until you switch away", async function () {
		const alice = query("alice");
		const bob = query("bob", {unread: 2, highlight: 1});
		const carol = query("carol");
		const {wrapper, names, open} = setup([alice, bob, carol], true);

		expect(names()).to.deep.equal(["bob"]);

		await open(alice);
		expect(names()).to.deep.equal(["bob", "alice"]);

		await open(carol);
		expect(names()).to.deep.equal(["bob", "carol"]);

		await open(undefined);
		expect(names()).to.deep.equal(["bob"]);
		wrapper.unmount();
	});

	it("keeps the open DM visible past the show-more limit", async function () {
		const queries = ["a", "b", "c", "d", "e", "f", "g"].map((n) => query(n));
		const {wrapper, names, open} = setup(queries, false);

		expect(names()).to.deep.equal(["a", "b", "c", "d", "e"]);
		expect(wrapper.find(".dm-show-more").text()).to.equal("Show 2 more...");

		await open(queries[6]);
		expect(names()).to.deep.equal(["a", "b", "c", "d", "e", "g"]);
		expect(wrapper.find(".dm-show-more").text()).to.equal("Show 1 more...");

		await open(queries[0]);
		expect(names()).to.deep.equal(["a", "b", "c", "d", "e"]);
		wrapper.unmount();
	});

	it("keeps the open DM visible when pinned and unread fill the limit", async function () {
		const pinned = ["p1", "p2", "p3"].map((n) => query(n, {pinned: true}));
		const unread = ["u1", "u2"].map((n) => query(n, {unread: 1}));
		const quiet = query("quiet");
		const {wrapper, names, open} = setup([...pinned, ...unread, quiet], false);

		expect(names()).to.not.include("quiet");

		await open(quiet);
		expect(names()).to.include("quiet");
		wrapper.unmount();
	});
});
