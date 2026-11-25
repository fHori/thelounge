import {
	computed,
	defineComponent,
	h,
	markRaw,
	onBeforeUnmount,
	onMounted,
	reactive,
	ref,
	watch,
	type Component,
} from "vue";
import {store} from "./store";
import {navigate, switchToChannel} from "./router";
import {feature} from "./features";
import {browseChannels, backToConversation} from "./helpers/browseChannels";
import {toggleProfilePanel} from "./profiles";
import socket from "./socket";

/**
 * Theme client modules (version 1). A theme package can name a client module in
 * package.json ("thelounge": {"client": "client.js"}, listed in "files"); while
 * the theme is selected it is loaded once and its default export is called with
 * the API below. Modules add small components to named slots in the interface:
 *
 *   sidebar.rail.end   after the network list
 *   network.header     for each network, after its lobby   props {network}
 *   footer.start       start of the sidebar footer
 *   chat.header.title  after a conversation's title        props {network, channel}
 *   settings.top       top of the settings window
 *
 * Components are plain Vue components using the Vue functions passed in (the
 * module must not bundle its own Vue), written with setup(): the options API
 * (mounted, methods...) is turned off in this build. A component that throws is
 * removed.
 * Switching away from a theme with a module reloads the page.
 *
 * Other packages can have a client module too (same field); those load for
 * everyone. Packages with the advanced server API also get rpc() for their
 * server methods, onPush() for messages their server sends, and onInit() run
 * on every (re)connection.
 */

export const themeApiVersion = 1;

export const slotNames = [
	"sidebar.rail.end",
	"network.header",
	"footer.start",
	"chat.header.title",
	"settings.top",
] as const;

export type SlotName = (typeof slotNames)[number];

type Registration = {id: number; component: Component; theme: string};

export const slots = reactive(new Map<SlotName, Registration[]>());
let nextId = 1;
let loadedTheme: string | null = null;

export function removeRegistration(name: SlotName, id: number) {
	slots.set(
		name,
		(slots.get(name) || []).filter((r) => r.id !== id)
	);
}

// Calls to packages' server methods waiting for an answer
const pendingRpc = new Map<string, (r: {result?: unknown; error?: string}) => void>();
const pushListeners = new Map<string, ((data: unknown) => void)[]>(); // `${pkg} ${event}`
const initListeners: (() => void)[] = [];
let rpcCounter = 0;

socket.on("package:rpc:result", (r) => {
	pendingRpc.get(r.id)?.(r);
	pendingRpc.delete(r.id);
});

socket.on("package:push", (p) => {
	for (const fn of pushListeners.get(`${p.pkg} ${p.event}`) || []) {
		try {
			fn(p.data);
		} catch (e) {
			// eslint-disable-next-line no-console
			console.error(`Package ${p.pkg}: ${p.event} listener failed`, e);
		}
	}
});

socket.on("init", () => {
	for (const fn of initListeners) {
		try {
			fn();
		} catch (e) {
			// eslint-disable-next-line no-console
			console.error("A package's init listener failed", e);
		}
	}
});

function apiFor(theme: string) {
	const pkg = decodeURIComponent(theme);

	return Object.freeze({
		rpc(method: string, args?: unknown): Promise<unknown> {
			return new Promise((resolve, reject) => {
				const id = `p${++rpcCounter}`;
				const timer = setTimeout(() => {
					pendingRpc.delete(id);
					reject(new Error("timed out"));
				}, 30000);

				pendingRpc.set(id, (r) => {
					clearTimeout(timer);

					if (r.error) {
						reject(new Error(r.error));
					} else {
						resolve(r.result);
					}
				});
				socket.emit("package:rpc", {pkg, id, method, args});
			});
		},
		onPush(event: string, fn: (data: unknown) => void) {
			const key = `${pkg} ${event}`;
			pushListeners.set(key, [...(pushListeners.get(key) || []), fn]);
		},
		onInit(fn: () => void) {
			initListeners.push(fn);
		},
		socketConnected: () => socket.connected,
		version: themeApiVersion,
		// Components use setup(); the options API (mounted, methods...) is off in this build
		vue: Object.freeze({
			h,
			computed,
			ref,
			reactive,
			watch,
			defineComponent,
			onMounted,
			onBeforeUnmount,
		}),
		store,
		feature,
		actions: Object.freeze({
			switchToChannel,
			navigate,
			browseChannels,
			backToConversation,
			toggleUserlist: () => store.commit("toggleUserlist"),
			toggleProfilePanel,
			openQuickSwitcher: () => store.commit("quickSwitcherOpen", true),
		}),
		slots: Object.freeze({
			register(name: SlotName, component: Component) {
				if (!(slotNames as readonly string[]).includes(name)) {
					// eslint-disable-next-line no-console
					console.warn(`Theme ${theme}: there is no slot "${name}"`);
					return;
				}

				slots.set(name, [
					...(slots.get(name) || []),
					{id: nextId++, component: markRaw(component), theme},
				]);
			},
		}),
	});
}

/** Loads the selected theme's client module, if it has one. */
export async function loadThemeModule(isChange = false) {
	const theme = store.state.serverConfiguration?.themes.find(
		(t) => t.name === store.state.settings.theme
	);
	const name = theme?.client ? theme.name : null;

	if (name === loadedTheme) {
		return;
	}

	// A module can't be unloaded: start over without it (or with the new one)
	if (loadedTheme !== null || (isChange && name === null && loadedTheme !== null)) {
		window.location.reload();
		return;
	}

	if (!theme?.client || /[?&]nomodules/.test(window.location.search)) {
		return;
	}

	loadedTheme = theme.name;

	try {
		const url = new URL(`packages/${theme.name}/${theme.client}`, document.baseURI).href;
		const mod = (await import(/* webpackIgnore: true */ url)) as {
			default?: (api: ReturnType<typeof apiFor>) => void;
		};

		if (typeof mod.default === "function") {
			mod.default(apiFor(theme.name));
		}
	} catch (e) {
		// eslint-disable-next-line no-console
		console.error(`Theme ${theme.name}: its client module failed to load`, e);
	}
}

const loadedPackages = new Set<string>();

/** Loads the client modules of non-theme packages (once each). */
export async function loadPackageModules() {
	if (/[?&]nomodules/.test(window.location.search)) {
		return;
	}

	for (const mod of store.state.serverConfiguration?.packageModules || []) {
		if (loadedPackages.has(mod.name)) {
			continue;
		}

		loadedPackages.add(mod.name);

		try {
			const url = new URL(`packages/${mod.name}/${mod.client}`, document.baseURI).href;
			const imported = (await import(/* webpackIgnore: true */ url)) as {
				default?: (api: ReturnType<typeof apiFor>) => void;
			};

			if (typeof imported.default === "function") {
				imported.default(apiFor(mod.name));
			}
		} catch (e) {
			// eslint-disable-next-line no-console
			console.error(`Package ${mod.name}: its client module failed to load`, e);
		}
	}
}
