// Settings that were saved under a different (misspelled) name, old name to new
export const renamedSettings: Readonly<Record<string, string>> = {
	jumptoEabled: "jumpToEnabled",
	filterdmsEnabled: "filterDmsEnabled",
};

/**
 * Moves settings saved under an old name to their current name, in place.
 * A value already saved under the new name wins. Returns whether anything
 * changed, so the caller knows to save the settings again.
 */
export function migrateRenamedSettings(settings: Record<string, unknown>): boolean {
	let changed = false;

	for (const [oldName, newName] of Object.entries(renamedSettings)) {
		if (!Object.prototype.hasOwnProperty.call(settings, oldName)) {
			continue;
		}

		if (!Object.prototype.hasOwnProperty.call(settings, newName)) {
			settings[newName] = settings[oldName];
		}

		delete settings[oldName];
		changed = true;
	}

	return changed;
}

// Settings the server sets itself; clients may not change them
export const serverOwnedSettings: ReadonlySet<string> = new Set(["searchEnabled"]);
