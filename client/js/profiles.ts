import {reactive} from "vue";
import socket from "./socket";
import storage from "./localStorage";
import type {UserProfile} from "../../shared/types/profile";

/**
 * Profiles from WHOIS (asked silently, see server/plugins/userIdentLookup.ts),
 * for a DM's profile panel and the details page.
 */

type Entry = {loading: boolean; profile: UserProfile | null; at: number};

const profiles = reactive(new Map<string, Entry>());
const key = (target: number, nick: string) => `${target}:${nick.toLowerCase()}`;

socket.on("profile:info", (data) => {
	if (!data || typeof data.nick !== "string") {
		return;
	}

	profiles.set(key(Number(data.target), data.nick), {
		loading: false,
		profile: data.profile && typeof data.profile === "object" ? data.profile : null,
		at: Date.now(),
	});
});

/** The profile of `nick`, asking the server when unknown or older than a few minutes. */
export function getProfile(target: number, nick: string, refresh = false): Entry {
	const k = key(target, nick);
	const entry = profiles.get(k);

	if (!entry || (!entry.loading && (refresh || Date.now() - entry.at > 5 * 60 * 1000))) {
		profiles.set(k, {loading: true, profile: entry?.profile ?? null, at: Date.now()});
		socket.emit("profile:get", {target, nick});
	}

	return profiles.get(k)!;
}

// Whether the profile panel next to a DM is open (themes that show it)
const panelKey = "thelounge.state.profilePanel";
export const profilePanel = reactive({
	open: (() => {
		try {
			return storage.get(panelKey) !== "false";
		} catch {
			return true;
		}
	})(),
});

export function toggleProfilePanel() {
	profilePanel.open = !profilePanel.open;
	storage.set(panelKey, String(profilePanel.open));
}
