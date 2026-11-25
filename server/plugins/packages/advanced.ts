import fs from "fs";
import path from "path";
import type {Request, Response} from "express";

import log from "../../log.js";
import Config from "../../config.js";
import type Client from "../../client.js";
import type Network from "../../models/network.js";
import type Chan from "../../models/chan.js";
import type Msg from "../../models/msg.js";
import type {TrackerInfo} from "../../../shared/types/network.js";

/**
 * The advanced package API (version 1): events, methods a package's client
 * module can call, messages to users' browsers, and routes. Off by default:
 * only packages the admin allowed get it (`thelounge packages allow <name>`, or
 * answering yes when installing). A package asks for it with
 * "thelounge": {"api": ["server"]}; without permission its code isn't run.
 *
 * Packages with server code can do anything The Lounge can, so this is about
 * the admin knowing which ones run, not a sandbox.
 */

export const advancedApiVersion = 1;

// --- Which packages may use it ---

const allowedFile = () => path.join(Config.getPackagesPath(), "allowed-server-packages.json");

export function allowedPackages(): string[] {
	try {
		const list: unknown = JSON.parse(fs.readFileSync(allowedFile(), "utf-8"));
		return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : [];
	} catch {
		return [];
	}
}

export function isAllowed(packageName: string) {
	return allowedPackages().includes(packageName);
}

export function setAllowed(packageName: string, allowed: boolean) {
	const list = new Set(allowedPackages());

	if (allowed) {
		list.add(packageName);
	} else {
		list.delete(packageName);
	}

	fs.mkdirSync(path.dirname(allowedFile()), {recursive: true});
	fs.writeFileSync(allowedFile(), JSON.stringify([...list].sort(), null, "\t") + "\n");
}

/** Whether a package.json asks for the advanced API. */
export function wantsAdvancedApi(thelounge: unknown) {
	const api = (thelounge as {api?: unknown} | undefined)?.api;
	return Array.isArray(api) && api.includes("server");
}

// --- Registry ---

export type PackageClient = {
	name: string;
	networks: Network[];
};

export type MessageEvent = {
	client: PackageClient;
	network: Network;
	channel: {name: string; type: string};
	message: {type: string; nick: string; text: string; self: boolean};
};

export type SocketEvent = {client: PackageClient; socketId: string};

type Events = {
	message: MessageEvent;
	"socket:connect": SocketEvent;
	"socket:disconnect": SocketEvent;
};

type RpcContext = {client: PackageClient; socketId: string};
type RpcHandler = (ctx: RpcContext, args: unknown) => unknown;
// `rest` is what follows the route's path ("img" serves img/<rest>)
type RouteHandler = (req: Request, res: Response, rest: string) => void;

const listeners = new Map<keyof Events, {pkg: string; fn: (e: never) => void}[]>();
const methods = new Map<string, Map<string, RpcHandler>>(); // package → method → handler
const routes = new Map<string, Map<string, RouteHandler>>(); // package → path → handler

// How the server reaches users and their browsers, set by server.ts
type Transport = {
	clients: () => Client[];
	toClient: (client: Client, pkg: string, event: string, data: unknown) => void;
	toSocket: (socketId: string, pkg: string, event: string, data: unknown) => void;
};

let transport: Transport | null = null;

export function setTransport(t: Transport) {
	transport = t;
}

const view = (client: Client): PackageClient => ({name: client.name, networks: client.networks});

function findClient(name: string) {
	return transport?.clients().find((c) => c.name === name);
}

/** Calls the listeners of an event; a listener that throws is logged and skipped. */
export function emitEvent<K extends keyof Events>(name: K, event: Events[K]) {
	for (const {pkg, fn} of listeners.get(name) || []) {
		try {
			(fn as (e: Events[K]) => void)(event);
		} catch (e) {
			log.error(`[${pkg}] ${name} listener failed: ${String(e)}`);
		}
	}
}

export function messageEvent(client: Client, network: Network, chan: Chan, msg: Msg) {
	if (!listeners.has("message")) {
		return;
	}

	emitEvent("message", {
		client: view(client),
		network,
		channel: {name: chan.name, type: chan.type},
		message: {
			type: msg.type,
			nick: msg.from?.nick || "",
			text: msg.text || "",
			self: Boolean(msg.self),
		},
	});
}

export function socketEvent(
	name: "socket:connect" | "socket:disconnect",
	client: Client,
	socketId: string
) {
	emitEvent(name, {client: view(client), socketId});
}

/** A method call from a package's client module. Answers with {result} or {error}. */
export async function callMethod(
	client: Client,
	socketId: string,
	pkg: string,
	method: string,
	args: unknown
): Promise<{result?: unknown; error?: string}> {
	const handler = methods.get(pkg)?.get(method);

	if (!handler) {
		return {error: "no such method"};
	}

	try {
		return {result: await handler({client: view(client), socketId}, args)};
	} catch (e) {
		log.error(`[${pkg}] method ${method} failed: ${String(e)}`);
		return {error: "failed"};
	}
}

/** The route of a package that answers this path, and what follows its own path. */
export function routeFor(pkg: string, routePath: string) {
	const mine = routes.get(pkg);

	if (!mine) {
		return null;
	}

	for (const [prefix, handler] of mine) {
		if (routePath === prefix || routePath.startsWith(prefix + "/")) {
			return {handler, rest: routePath.slice(prefix.length + 1)};
		}
	}

	return null;
}

/** Drops everything a package registered (tests, reloads). */
export function forgetPackage(pkg: string) {
	for (const [name, list] of listeners) {
		listeners.set(
			name,
			list.filter((l) => l.pkg !== pkg)
		);
	}

	methods.delete(pkg);
	routes.delete(pkg);
}

const routePathRegex = /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/;
const methodRegex = /^[a-zA-Z][a-zA-Z0-9:._-]{0,63}$/;

/** The API object given to an allowed package. */
export function advancedApiFor(pkg: string) {
	return Object.freeze({
		version: advancedApiVersion,
		events: Object.freeze({
			on<K extends keyof Events>(name: K, fn: (e: Events[K]) => void) {
				listeners.set(name, [...(listeners.get(name) || []), {pkg, fn: fn}]);
			},
		}),
		rpc: Object.freeze({
			register(method: string, handler: RpcHandler) {
				if (!methodRegex.test(method)) {
					throw new Error(`invalid method name "${method}"`);
				}

				if (!methods.has(pkg)) {
					methods.set(pkg, new Map());
				}

				methods.get(pkg)!.set(method, handler);
			},
		}),
		push: Object.freeze({
			/** To every open browser of a user. */
			toUser(userName: string, event: string, data: unknown) {
				const client = findClient(userName);

				if (client) {
					transport?.toClient(client, pkg, event, data);
				}
			},
			/** To one browser. */
			toSocket(socketId: string, event: string, data: unknown) {
				transport?.toSocket(socketId, pkg, event, data);
			},
		}),
		routes: Object.freeze({
			/** Answers GET /packages/<package>/x/<path> and everything under it. */
			get(routePath: string, handler: RouteHandler) {
				if (
					!routePathRegex.test(routePath) ||
					routePath.split("/").some((segment) => /^\.+$/.test(segment))
				) {
					throw new Error(`invalid route path "${routePath}"`);
				}

				if (!routes.has(pkg)) {
					routes.set(pkg, new Map());
				}

				routes.get(pkg)!.set(routePath, handler);
			},
		}),
		users: Object.freeze({
			list: (): PackageClient[] => (transport?.clients() || []).map(view),
		}),
		trackers: Object.freeze({
			/** A tracker from config.js by id, or null. */
			get(id: string): {id: string; name: string} | null {
				const t = Config.values.trackers?.[id];
				return t && !t.disabled ? {id, name: t.name || id} : null;
			},
			/** Trackers of a network, as the client gets them. */
			forNetwork(network: Network): TrackerInfo[] {
				return Config.getTrackersForHost(network.host, network.irc?.network?.server) || [];
			},
		}),
		/** This package's settings from config.js: packageConfig["<package>"]. */
		config(): Record<string, unknown> {
			const all = (Config.values as {packageConfig?: Record<string, unknown>}).packageConfig;
			const mine = all?.[pkg];
			return mine && typeof mine === "object" ? (mine as Record<string, unknown>) : {};
		},
	});
}

export type AdvancedApi = ReturnType<typeof advancedApiFor>;
