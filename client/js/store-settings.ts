import storage from "./localStorage";
import socket from "./socket";
import {config, createState, SettingsState} from "./settings";
import {Store} from "vuex";
import {State} from "./store";
import {migrateRenamedSettings} from "../../shared/settings";

export function createSettingsStore(store: Store<State>) {
	return {
		namespaced: true,
		state: assignStoredSettings(createState() as SettingsState, loadFromLocalStorage()),
		mutations: {
			set(state, {name, value}) {
				state[name] = value;
			},
		},
		actions: {
			syncAll({state}, force = false) {
				if (state.syncSettings === false && force === false) {
					return;
				}

				store.commit("serverHasSettings", true);

				for (const name in state) {
					if (config[name].sync !== "never" && config[name].sync !== "server") {
						socket.emit("setting:set", {name, value: state[name]});
					}
				}
			},
			applyAll({state}) {
				for (const settingName in config) {
					config[settingName].apply(store, state[settingName], true);
				}
			},
			update({state, commit}, {name, value, sync = false}) {
				if (state[name] === value) {
					return;
				}

				const settingConfig = config[name];

				// Trying to update a non existing setting (e.g. server has an old key)
				if (!settingConfig) {
					return;
				}

				if (settingConfig.sync === "server") {
					// Only the server decides these, whether settings sync is on or not
					if (sync) {
						return;
					}
				} else if (
					sync === false &&
					(state.syncSettings === false || settingConfig.sync === "never")
				) {
					return;
				}

				commit("set", {name, value});
				saveToLocalStorage(state);
				settingConfig.apply(store, value);

				if (!sync) {
					return;
				}

				if (
					(state.syncSettings && settingConfig.sync !== "never") ||
					settingConfig.sync === "always"
				) {
					socket.emit("setting:set", {name, value});
				}
			},
		},
	};
}

// Server-owned settings are not kept, the server sends them on every load
function saveToLocalStorage(state: SettingsState) {
	const stored: Record<string, unknown> = {};

	for (const name in state) {
		if (config[name]?.sync !== "server") {
			stored[name] = state[name];
		}
	}

	storage.set("settings", JSON.stringify(stored));
}

function loadFromLocalStorage(): Record<string, unknown> {
	let storedSettings: Record<string, unknown> = {};

	try {
		storedSettings = JSON.parse(storage.get("settings") || "{}");
	} catch {
		storage.remove("settings");
	}

	if (!storedSettings) {
		return {};
	}

	// Settings renamed since they were stored, keep the user's value
	if (migrateRenamedSettings(storedSettings)) {
		storage.set("settings", JSON.stringify(storedSettings));
	}

	// Older The Lounge versions converted highlights to an array, turn it back into a string
	if (storedSettings.highlights !== null && typeof storedSettings.highlights === "object") {
		storedSettings.highlights = (storedSettings.highlights as string[]).join(", ");
	}

	return storedSettings;
}

/**
 * Essentially Object.assign but does not overwrite and only assigns
 * if key exists in both supplied objects and types match
 *
 * @param {object} defaultSettings
 * @param {object} storedSettings
 */
function assignStoredSettings(
	defaultSettings: SettingsState,
	storedSettings: Record<string, unknown>
) {
	const newSettings = {...defaultSettings};

	for (const key in defaultSettings) {
		// Make sure the setting in local storage has the same type that the code expects
		if (
			config[key]?.sync !== "server" &&
			typeof storedSettings[key] !== "undefined" &&
			typeof defaultSettings[key] === typeof storedSettings[key]
		) {
			newSettings[key] = storedSettings[key];
		}
	}

	return newSettings;
}
