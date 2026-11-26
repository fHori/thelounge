import {expect} from "chai";
import {execFileSync} from "child_process";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import type {Server} from "http";
import type {AddressInfo} from "net";
import {fileURLToPath} from "url";

import {precompressed, setStaticHeaders} from "../server/staticAssets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Static assets", function () {
	const js = "console.log('the lounge');\n".repeat(100);
	let root: string;
	let server: Server;
	let base: string;

	before(async function () {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "thelounge-static-"));
		fs.mkdirSync(path.join(root, "js"));
		fs.writeFileSync(path.join(root, "js/bundle.js"), js);
		fs.writeFileSync(path.join(root, "js/bundle.js.br"), zlib.brotliCompressSync(js));
		fs.writeFileSync(path.join(root, "js/bundle.js.gz"), zlib.gzipSync(js));
		fs.writeFileSync(path.join(root, "js/chunk.0123abcd.js"), js);
		fs.writeFileSync(path.join(root, "plain.txt"), "plain");

		const app = express()
			.use(precompressed(root))
			.use(express.static(root, {maxAge: 86400 * 1000, setHeaders: setStaticHeaders}));

		server = await new Promise<Server>((resolve) => {
			const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
		});

		const {port} = server.address() as AddressInfo;
		base = `http://127.0.0.1:${port}/`;
	});

	after(function (done) {
		fs.rmSync(root, {recursive: true, force: true});
		server.close(done);
	});

	const get = (url: string, acceptEncoding: string) =>
		fetch(base + url, {headers: {"Accept-Encoding": acceptEncoding}});

	it("serves brotli when accepted", async function () {
		const response = await get("js/bundle.js", "gzip, deflate, br");

		expect(response.headers.get("content-encoding")).to.equal("br");
		expect(response.headers.get("content-type")).to.match(/javascript/);
		expect(response.headers.get("vary")).to.match(/Accept-Encoding/);
		// fetch decodes the body
		expect(await response.text()).to.equal(js);
	});

	it("serves gzip when brotli is not accepted", async function () {
		const response = await get("js/bundle.js", "gzip");

		expect(response.headers.get("content-encoding")).to.equal("gzip");
		expect(await response.text()).to.equal(js);
	});

	it("serves the original otherwise", async function () {
		const response = await get("js/bundle.js", "identity");

		expect(response.headers.get("content-encoding")).to.equal(null);
		expect(response.headers.get("vary")).to.match(/Accept-Encoding/);
		expect(await response.text()).to.equal(js);
	});

	it("marks versioned assets immutable", async function () {
		const versioned = await get("js/bundle.js?v=abc", "br");
		expect(versioned.headers.get("cache-control")).to.equal(
			"public, max-age=31536000, immutable"
		);

		const chunk = await get("js/chunk.0123abcd.js", "br");
		expect(chunk.headers.get("cache-control")).to.include("immutable");

		const plain = await get("plain.txt", "br");
		expect(plain.headers.get("cache-control")).to.equal("public, max-age=86400");
	});

	it("keeps the icon font subset in step with the sources", function () {
		const script = path.join(__dirname, "../scripts/subset-icons.mjs");
		execFileSync(process.execPath, [script, "--check"], {stdio: "pipe"});
	});
});
