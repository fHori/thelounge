import {expect} from "chai";
import sinon from "sinon";
import {createStore, Store} from "vuex";
import socket from "../../../client/js/socket";
import {config, SettingsState} from "../../../client/js/settings.js";
import type {State} from "../../../client/js/store.js";
import {createSettingsStore} from "../../../client/js/store-settings.js";
import {serverOwnedSettings} from "../../../shared/settings.js";

describe("settings store", function () {
	// The test bundle replaces the socket with a stand-in that has no methods
	const testSocket = socket as unknown as {emit?: sinon.SinonSpy};
	let emit: sinon.SinonSpy;

	const makeStore = (): Store<{settings: SettingsState}> => {
		const store = createStore({
			state: {serverHasSettings: false},
			mutations: {
				serverHasSettings() {},
				refreshDesktopNotificationState() {},
			},
		});
		store.registerModule("settings", createSettingsStore(store as unknown as Store<State>));
		return store as unknown as Store<{settings: SettingsState}>;
	};

	beforeEach(function () {
		window.localStorage.clear();
		emit = sinon.spy();
		testSocket.emit = emit;
	});

	afterEach(function () {
		delete testSocket.emit;
		window.localStorage.clear();
	});

	it("should mark the same settings as server-owned as the server does", function () {
		const flagged = Object.keys(config).filter((name) => config[name].sync === "server");
		expect(flagged).to.have.members([...serverOwnedSettings]);
	});

	it("should take searchEnabled from the server with settings sync off", async function () {
		window.localStorage.setItem(
			"settings",
			JSON.stringify({syncSettings: false, searchEnabled: false, coloredNicks: false})
		);
		const store = makeStore();

		expect(store.state.settings.syncSettings).to.equal(false);
		// A stored value is not trusted, the server sends it on load
		expect(store.state.settings.searchEnabled).to.equal(false);

		await store.dispatch("settings/update", {name: "searchEnabled", value: true, sync: false});
		await store.dispatch("settings/update", {name: "coloredNicks", value: true, sync: false});

		expect(store.state.settings.searchEnabled).to.equal(true);
		// User preferences still stay local while sync is off
		expect(store.state.settings.coloredNicks).to.equal(false);
	});

	it("should not keep server-owned settings in local storage", async function () {
		window.localStorage.setItem("settings", JSON.stringify({searchEnabled: true}));
		const store = makeStore();

		expect(store.state.settings.searchEnabled).to.equal(false);

		await store.dispatch("settings/update", {name: "searchEnabled", value: true, sync: false});
		await store.dispatch("settings/update", {name: "coloredNicks", value: false, sync: true});

		const stored = JSON.parse(window.localStorage.getItem("settings") || "{}");
		expect(stored).to.not.have.property("searchEnabled");
		expect(stored.coloredNicks).to.equal(false);
	});

	it("should never send server-owned settings to the server", async function () {
		const store = makeStore();

		await store.dispatch("settings/update", {name: "searchEnabled", value: true, sync: true});
		expect(store.state.settings.searchEnabled).to.equal(false);

		await store.dispatch("settings/syncAll", true);
		const sent = emit
			.getCalls()
			.filter((call) => call.args[0] === "setting:set")
			.map((call) => (call.args[1] as {name: string}).name);

		expect(sent).to.include("coloredNicks");
		expect(sent).to.not.include("searchEnabled");
		expect(sent).to.not.include("syncSettings");
	});
});
