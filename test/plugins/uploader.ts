import fs from "fs";
import {AddressInfo} from "net";
import {Server} from "http";
import {expect} from "chai";
import sinon from "sinon";
import type {Socket} from "socket.io";
import util from "../util.js";
import Config from "../../server/config.js";
import Uploader from "../../server/plugins/uploader.js";

describe("Uploader", function () {
	this.timeout(util.isRunningOnCI() ? 25000 : 5000);
	this.slow(300);

	// Keep a reference to the real fetch, as the global one gets stubbed
	// to intercept requests to the external upload providers
	const realFetch = globalThis.fetch;

	let server: Server;
	let baseURL: string;
	let fetchStub: sinon.SinonStub;
	let uploadPathExisted: boolean;
	let originalBackendSelection: boolean;
	let originalPublic: boolean;

	// Simulates the authenticated socket and requests a one-time upload token
	const getUploadToken = () => {
		const handlers: Record<string, (...args: unknown[]) => void> = {};
		let token = "";

		const socket = {
			on(event: string, handler: (...args: unknown[]) => void) {
				handlers[event] = handler;
			},
			emit(event: string, value: string) {
				if (event === "upload:auth") {
					token = value;
				}
			},
		} as unknown as Socket;

		new Uploader(socket);
		handlers["upload:auth"]();

		return token;
	};

	const upload = (
		service: string,
		token: string,
		fields: Record<string, string> = {},
		ttl?: string
	) => {
		const formData = new FormData();

		for (const [key, value] of Object.entries(fields)) {
			formData.append(key, value);
		}

		formData.append("file", new File(["hello"], "hello.txt", {type: "text/plain"}));

		return realFetch(
			`${baseURL}/uploads/${service}/${encodeURIComponent(token)}${ttl ? `/${ttl}` : ""}`,
			{method: "POST", body: formData}
		);
	};

	before(function (done) {
		uploadPathExisted = fs.existsSync(Config.getFileUploadPath());

		const app = util.createWebserver();
		Uploader.router(app);

		server = app.listen(0, "127.0.0.1", () => {
			baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			done();
		});
	});

	after(function (done) {
		if (!uploadPathExisted) {
			fs.rmSync(Config.getFileUploadPath(), {recursive: true, force: true});
		}

		server.close(done);
	});

	beforeEach(function () {
		originalBackendSelection = Config.values.allowFileUploadBackendSelection;
		Config.values.allowFileUploadBackendSelection = true;
		originalPublic = Config.values.public;
		Config.values.public = false;
		fetchStub = sinon.stub(globalThis, "fetch");
	});

	afterEach(function () {
		Config.values.allowFileUploadBackendSelection = originalBackendSelection;
		Config.values.public = originalPublic;
		fetchStub.restore();
	});

	it("should reject an external provider upload without a valid token", async function () {
		const response = await upload("catbox", "not-a-valid-token");

		expect(response.status).to.equal(403);
		expect(await response.json()).to.deep.equal({error: "Invalid upload token"});
		expect(fetchStub.called).to.equal(false);
	});

	it("should reject an external provider upload without any token", async function () {
		const response = await realFetch(`${baseURL}/uploads/catbox`, {
			method: "POST",
			body: new FormData(),
		});

		expect(response.status).to.not.equal(200);
		expect(fetchStub.called).to.equal(false);
	});

	it("should reject an external provider when backend selection is disabled", async function () {
		Config.values.allowFileUploadBackendSelection = false;

		const response = await upload("catbox", getUploadToken());

		expect(response.status).to.equal(403);
		expect(await response.json()).to.deep.equal({
			error: "Upload provider selection is disabled",
		});
		expect(fetchStub.called).to.equal(false);
	});

	it("should reject providers with a user supplied address in public mode", async function () {
		Config.values.public = true;

		const response = await upload("rustypaste", getUploadToken(), {
			uploadURL: "http://127.0.0.1:9/",
		});

		expect(response.status).to.equal(403);
		expect(fetchStub.called).to.equal(false);
	});

	it("should reject a field that was cut off at the size limit", async function () {
		const response = await upload("imagebb", getUploadToken(), {apiKey: "k".repeat(5000)});

		expect(response.status).to.equal(400);
		expect(await response.json()).to.deep.equal({error: "Field too long"});
		expect(fetchStub.called).to.equal(false);
	});

	it("should reject an api key containing the separator", async function () {
		const response = await upload("zipline", getUploadToken(), {
			uploadURL: "http://zipline.example/api/upload",
			apiKey: "abc_|_def",
		});

		expect(response.status).to.equal(400);
		expect(fetchStub.called).to.equal(false);
	});

	it("should still allow local uploads when backend selection is disabled", async function () {
		Config.values.allowFileUploadBackendSelection = false;

		const response = await upload("new", getUploadToken());
		const json = await response.json();

		expect(response.status).to.equal(200);
		expect(json.url).to.match(/^uploads\/[0-9a-f]{16}\/hello\.txt$/);
	});

	it("should upload to an external provider with a valid token, only once", async function () {
		fetchStub.resolves(new Response("https://files.catbox.moe/abc.txt"));

		const token = getUploadToken();
		const response = await upload("catbox", token, {}, "forever");

		expect(response.status).to.equal(200);
		expect(await response.json()).to.deep.equal({url: "https://files.catbox.moe/abc.txt"});
		expect(fetchStub.calledOnce).to.equal(true);

		const reused = await upload("catbox", token, {}, "forever");

		expect(reused.status).to.equal(403);
		expect(fetchStub.calledOnce).to.equal(true);
	});

	it("should read the api key from the form fields", async function () {
		fetchStub.resolves(new Response("https://ptscreens.com/abc.png"));

		const response = await upload("ptscreens", getUploadToken(), {apiKey: "secret"});

		expect(response.status).to.equal(200);
		expect((fetchStub.firstCall.args[1].body as FormData).get("key")).to.equal("secret");
	});

	it("should reject a provider that requires an api key when none is sent", async function () {
		const response = await upload("ptscreens", getUploadToken());

		expect(response.status).to.equal(400);
		expect(await response.json()).to.deep.equal({error: "Missing API Key"});
		expect(fetchStub.called).to.equal(false);
	});

	it("should pass the upload url and api key to self-hosted providers", async function () {
		fetchStub.resolves(new Response("http://192.168.1.10:8000/hello.txt\n"));

		const response = await upload("rustypaste", getUploadToken(), {
			apiKey: "secret",
			uploadURL: "http://192.168.1.10:8000",
		});

		expect(response.status).to.equal(200);
		expect(await response.json()).to.deep.equal({url: "http://192.168.1.10:8000/hello.txt"});

		const [requestURL, init] = fetchStub.firstCall.args;
		expect(requestURL).to.equal("http://192.168.1.10:8000/");
		expect(init.headers.authorization).to.equal("Bearer secret");
	});

	for (const uploadURL of ["", "not a url", "ftp://example.com/", "file:///etc/passwd"]) {
		it(`should reject the invalid upload url "${uploadURL}"`, async function () {
			const response = await upload("rustypaste", getUploadToken(), {uploadURL});

			expect(response.status).to.equal(400);
			expect(await response.json()).to.deep.equal({error: "Invalid Upload URL"});
			expect(fetchStub.called).to.equal(false);
		});
	}

	it("should not reflect the upstream response body of self-hosted providers", async function () {
		fetchStub.resolves(new Response("internal secret page", {status: 500}));

		const response = await upload("rustypaste", getUploadToken(), {
			uploadURL: "http://127.0.0.1:1234/",
		});
		const json = await response.json();

		expect(response.status).to.equal(400);
		expect(json.error).to.equal("Upload to rustypaste failed");
	});

	it("should truncate error messages from public providers", async function () {
		fetchStub.resolves(new Response(`${"x".repeat(500)}\nsecond line`, {status: 500}));

		const response = await upload("catbox", getUploadToken());
		const json = await response.json();

		expect(response.status).to.equal(400);
		expect(json.error).to.equal(`${"x".repeat(100)}...`);
	});

	it("should not pass HTML error pages from public providers through", async function () {
		fetchStub.resolves(new Response("<!DOCTYPE HTML><HTML><META NAME=\"ROBOTS\">", {status: 403}));

		const response = await upload("catbox", getUploadToken());
		const json = await response.json();

		expect(response.status).to.equal(400);
		expect(json.error).to.match(/^Catbox rejected the upload \(HTTP 403\)/);
	});
});
