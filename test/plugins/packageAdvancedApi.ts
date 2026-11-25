import {expect} from "chai";
import fs from "fs";
import path from "path";
import Config from "../../server/config.js";
import {
	advancedApiFor,
	callMethod,
	emitEvent,
	forgetPackage,
	isAllowed,
	routeFor,
	setAllowed,
	wantsAdvancedApi,
} from "../../server/plugins/packages/advanced.js";
import type Client from "../../server/client.js";

describe("advanced package API", function () {
	afterEach(function () {
		forgetPackage("test-pkg");
		fs.rmSync(path.join(Config.getPackagesPath(), "allowed-server-packages.json"), {force: true});
	});

	it("is only for packages that ask for it and are allowed", function () {
		expect(wantsAdvancedApi({api: ["server"]})).to.equal(true);
		expect(wantsAdvancedApi({api: []})).to.equal(false);
		expect(wantsAdvancedApi(undefined)).to.equal(false);

		expect(isAllowed("test-pkg")).to.equal(false);
		setAllowed("test-pkg", true);
		expect(isAllowed("test-pkg")).to.equal(true);
		setAllowed("test-pkg", false);
		expect(isAllowed("test-pkg")).to.equal(false);
	});

	it("routes requests under a package's path to its handler", function () {
		const api = advancedApiFor("test-pkg");
		api.routes.get("img", () => {});

		expect(routeFor("test-pkg", "img/abc.png")?.rest).to.equal("abc.png");
		expect(routeFor("test-pkg", "imgx/abc.png")).to.equal(null);
		expect(routeFor("other-pkg", "img/abc.png")).to.equal(null);
		expect(() => api.routes.get("../up", () => {})).to.throw();
	});

	it("calls a package's methods with the caller, and reports failures", async function () {
		const api = advancedApiFor("test-pkg");
		api.rpc.register("echo", (ctx, args) => ({user: ctx.client.name, args}));
		api.rpc.register("boom", () => {
			throw new Error("nope");
		});

		const client = {name: "alice", networks: []} as unknown as Client;

		expect(await callMethod(client, "s1", "test-pkg", "echo", 42)).to.deep.equal({
			result: {user: "alice", args: 42},
		});
		expect(await callMethod(client, "s1", "test-pkg", "boom", null)).to.deep.equal({
			error: "failed",
		});
		expect(await callMethod(client, "s1", "test-pkg", "missing", null)).to.deep.equal({
			error: "no such method",
		});
	});

	it("delivers events, and a failing listener doesn't stop the others", function () {
		const api = advancedApiFor("test-pkg");
		const seen: string[] = [];

		api.events.on("socket:connect", () => {
			throw new Error("bad listener");
		});
		api.events.on("socket:connect", (e) => seen.push(e.socketId));

		emitEvent("socket:connect", {client: {name: "alice", networks: []}, socketId: "s9"});
		expect(seen).to.deep.equal(["s9"]);
	});
});
