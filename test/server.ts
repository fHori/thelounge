import log from "../server/log.js";
import Config from "../server/config.js";
import {expect, vi} from "vitest";
import io from "socket.io-client";
import changelog from "../server/plugins/changelog.js";

import sinon from "sinon";
import type {AddressInfo} from "net";
import ClientManager from "../server/clientManager.js";

describe("Server", function () {
	let serverInstance: import("../server/server.js").ServerInstance;
	let logInfoStub: sinon.SinonStub<string[], void>;
	let logWarnStub: sinon.SinonStub<string[], void>;
	let checkForUpdatesStub: sinon.SinonStub<[manager: ClientManager], void>;

	beforeAll(async function () {
		logInfoStub = sinon.stub(log, "info");
		logWarnStub = sinon.stub(log, "warn").callsFake((...args: string[]) => {
			// vapid.json permissions do not survive in git
			if (args.length > 1 && args[1] === "is world readable.") {
				return;
			}

			if (args.length > 0 && args[0].startsWith("run `chmod")) {
				return;
			}

			// eslint-disable-next-line no-console
			console.error(`Unhandled log.warn in server tests: ${args.join(" ")}`);
		});

		checkForUpdatesStub = sinon.stub(changelog, "checkForUpdates");
		serverInstance = await (await import("../server/server.js")).default({dev: false});
	});

	afterAll(async function () {
		logInfoStub.restore();
		logWarnStub.restore();
		checkForUpdatesStub.restore();
		// Use stop() method which properly closes Socket.IO then HTTP server
		await new Promise<void>((resolve, reject) =>
			serverInstance.stop((err) => (err ? reject(err) : resolve()))
		);

		await vi.dynamicImportSettled();
	});

	// The address the server under test actually listens on
	const webURL = () => {
		const {address, port} = serverInstance.httpServer.address() as AddressInfo;
		return `http://${address}:${port}/`;
	};

	describe("Express", () => {
		it("should run a web server", async () => {
			const response = await fetch(webURL());
			const body = await response.text();
			expect(response.status).to.equal(200);
			expect(body).to.include("<title>The Lounge</title>");
			expect(body).to.include('type="module"');
		});

		it("should serve static content correctly", async () => {
			const response = await fetch(webURL() + "thelounge.webmanifest");
			const body = (await response.json()) as {name: string};

			expect(response.status).to.equal(200);
			expect(body.name).to.equal("The Lounge");
			expect(response.headers.get("content-type")).to.match(
				/^application\/manifest\+json(?:;\s*charset=utf-8)?$/
			);
		});
	});

	describe("WebSockets", function () {
		let client: ReturnType<typeof io>;

		beforeEach(() => {
			client = io(webURL(), {
				path: "/socket.io/",
				autoConnect: false,
				reconnection: false,
				timeout: 1000,
				transports: ["websocket"],
			});

			// Server emits events faster than the test can bind them
			setTimeout(() => {
				client.open();
			}, 1);
		});

		afterEach(() => {
			client.close();
		});

		it("should emit authorized message", () =>
			new Promise<void>((resolve) => {
				client.on("auth:success", () => resolve());
			}));

		it("should create network", () =>
			new Promise<void>((resolve) => {
				client.on("init", () => {
					client.emit("network:new", {
						username: "test-user",
						realname: "The Lounge Test",
						nick: "test-user",
						join: "#thelounge, #spam",
						name: "Test Network",
						host: Config.values.host,
						port: 6667,
					});
				});

				client.on("network", (data) => {
					expect(data.network).to.exist;
					expect(data.network.nick).to.equal("test-user");
					expect(data.network.name).to.equal("Test Network");
					expect(data.network.channels).to.have.lengthOf(3);
					expect(data.network.channels[0].name).to.equal("Test Network");
					expect(data.network.channels[1].name).to.equal("#thelounge");
					expect(data.network.channels[2].name).to.equal("#spam");
					resolve();
				});
			}));

		it("should emit configuration message", () =>
			new Promise<void>((resolve) => {
				client.on("configuration", (data) => {
					// Private key defined in vapid.json is "01020304050607080910111213141516" for this public key.
					expect(data.applicationServerKey).to.equal(
						"BM0eTDpvDnH7ewlHuXWcPTE1NjlJ06XWIS1cQeBTZmsg4EDx5sOpY7kdX1pniTo8RakL3UdfFuIbC8_zog_BWIM"
					);

					expect(data.public).to.equal(true);
					expect(data.defaultTheme).to.equal("default");
					expect(data.themes).to.be.an("array");
					expect(data.lockNetwork).to.equal(false);
					expect(data.useHexIp).to.equal(false);

					resolve();
				});
			}));

		it("should emit push subscription state message", () =>
			new Promise<void>((resolve) => {
				client.on("push:issubscribed", (data) => {
					expect(data).to.be.false;

					resolve();
				});
			}));

		it("should emit init message", () =>
			new Promise<void>((resolve) => {
				client.on("init", (data) => {
					expect(data.active).to.equal(-1);
					expect(data.networks).to.be.an("array");
					expect(data.networks).to.be.empty;
					expect(data.token).to.be.undefined;

					resolve();
				});
			}));
	});
});
