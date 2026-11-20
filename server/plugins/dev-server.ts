import {createServer as createViteServer} from "vite";
import express from "express";
import fs from "fs";

import log from "../log.js";
import fromRoot from "../rootpath.js";
import {injectServerConfig} from "./html-config.js";

export default async (app: express.Application) => {
	log.debug("Starting server in development mode");

	const vite = await createViteServer({
		configFile: fromRoot("vite.config.mts"),
		server: {middlewareMode: true},
		appType: "custom",
	});

	app.use(vite.middlewares);

	app.get("/", async (req, res) => {
		const rawHtml = fs.readFileSync(fromRoot("client", "index.html"), "utf-8");
		const html = await vite.transformIndexHtml(req.url, rawHtml);
		res.setHeader("Content-Type", "text/html");
		res.send(injectServerConfig(html));
	});
};
