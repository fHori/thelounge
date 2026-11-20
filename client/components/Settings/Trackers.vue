<template>
	<div id="tracker-settings">
		<SettingCard title="Trackers">
			<div class="setting-card-intro">
				Trackers give users a "Tracker Profile" link in their context menu. Changes here
				only apply to you.
			</div>
		</SettingCard>

		<SettingCard v-if="serverTrackers.length > 0" title="From the server">
			<div v-for="item in serverTrackers" :key="item.key" class="setting-row">
				<div class="setting-row-text">
					<div class="setting-row-label">
						{{ item.tracker.name }}
						<span class="tracker-network">{{ item.network.name }}</span>
					</div>
					<div v-if="item.entry?.hidden" class="setting-row-description">
						Profile link hidden
					</div>
					<div v-else-if="item.entry?.profileUrl" class="setting-row-description">
						Your link: {{ item.entry.profileUrl }}
					</div>
					<div v-else-if="item.tracker.profileUrl" class="setting-row-description">
						{{ item.tracker.profileUrl }}
					</div>
					<div v-else class="setting-row-description">No profile link</div>
				</div>
				<div class="tracker-row-btns">
					<button type="button" class="btn btn-small" @click="editOverride(item)">
						Change link
					</button>
					<button
						v-if="item.entry"
						type="button"
						class="btn btn-small"
						@click="removeEntry(item.entry)"
					>
						Reset
					</button>
					<button v-else type="button" class="btn btn-small" @click="hide(item)">
						Hide
					</button>
				</div>
			</div>
		</SettingCard>

		<SettingCard title="Your trackers">
			<div v-if="ownTrackers.length === 0" class="setting-card-intro">
				You have not added any trackers.
			</div>
			<div v-for="entry in ownTrackers" :key="entry.network + entry.id" class="setting-row">
				<div class="setting-row-text">
					<div class="setting-row-label">
						{{ entry.name ?? entry.id }}
						<span class="tracker-network">
							{{ networkLabel(entry.network) }}
							<template v-if="entry.channels">
								· {{ entry.channels.join(", ") }}</template
							>
						</span>
					</div>
					<div v-if="entry.hidden" class="setting-row-description">
						Hides the server's profile link
					</div>
					<div v-else-if="entry.profileUrl" class="setting-row-description">
						{{ entry.profileUrl }}
					</div>
					<div v-else class="setting-row-description error">
						No usable profile address
					</div>
				</div>
				<div class="tracker-row-btns">
					<button
						v-if="!entry.hidden"
						type="button"
						class="btn btn-small"
						@click="editOwn(entry)"
					>
						Edit
					</button>
					<button type="button" class="btn btn-small" @click="removeEntry(entry)">
						Remove
					</button>
				</div>
			</div>
			<div v-if="!form" class="setting-action-row">
				<button
					type="button"
					class="btn btn-small"
					:disabled="networkHosts.length === 0"
					@click="addNew"
				>
					Add a tracker
				</button>
			</div>
		</SettingCard>

		<SettingCard
			v-if="form"
			:title="
				form.mode === 'override'
					? 'Profile link for ' + form.name
					: form.mode === 'edit'
						? 'Edit tracker'
						: 'Add a tracker'
			"
		>
			<div class="tracker-form" @keydown.enter.prevent="save">
				<template v-if="form.mode !== 'override'">
					<label for="tracker-name" class="setting-row-text">
						<div class="setting-row-label">Name</div>
					</label>
					<input
						id="tracker-name"
						v-model="form.name"
						type="text"
						class="input"
						autocomplete="off"
						:maxlength="limits.text"
						placeholder="e.g. My Tracker"
					/>

					<label for="tracker-network" class="setting-row-text">
						<div class="setting-row-label">Network</div>
					</label>
					<select id="tracker-network" v-model="form.network" class="input">
						<option v-if="!hostIsListed(form.network)" :value="form.network">
							{{ form.network ? "A network you are not on" : "Choose a network" }}
						</option>
						<option v-for="host in networkHosts" :key="host.host" :value="host.host">
							{{ host.label }}
						</option>
					</select>

					<label for="tracker-channels" class="setting-row-text">
						<div class="setting-row-label">Channels</div>
						<div class="setting-row-description">Leave empty for the whole network</div>
					</label>
					<input
						id="tracker-channels"
						v-model="form.channels"
						type="text"
						class="input"
						autocomplete="off"
						placeholder="Comma-separated, e.g.: #tracker, #tracker-help"
					/>
				</template>

				<label for="tracker-profile-url" class="setting-row-text">
					<div class="setting-row-label">Profile address</div>
					<div class="setting-row-description">
						{nick} is replaced with the user's nick. Use {ident} instead where the
						tracker's IRC server puts the user id in the ident.
					</div>
				</label>
				<input
					id="tracker-profile-url"
					v-model="form.profileUrl"
					type="url"
					class="input"
					autocomplete="off"
					:maxlength="limits.url"
					placeholder="https://tracker.example/users/{nick}"
				/>

				<label for="tracker-user-host" class="setting-row-text">
					<div class="setting-row-label">Users' hostname</div>
					<div class="setting-row-description">
						Optional, only used with {ident}: what the hostname of the tracker's users
						looks like, * for any text
					</div>
				</label>
				<input
					id="tracker-user-host"
					v-model="form.userHost"
					type="text"
					class="input"
					autocomplete="off"
					:maxlength="limits.text"
					placeholder="e.g. *.users.tracker.example"
				/>

				<div v-if="formError" class="error">{{ formError }}</div>

				<div class="tracker-row-btns tracker-form-btns">
					<button type="button" class="btn btn-small" @click="save">Save</button>
					<button type="button" class="btn btn-small" @click="form = null">Cancel</button>
				</div>
			</div>
		</SettingCard>
	</div>
</template>

<style>
#tracker-settings .tracker-network {
	font-weight: 400;
	color: var(--body-color-muted);
	margin-left: 6px;
}

#tracker-settings .setting-row-description {
	overflow-wrap: break-word;
	word-break: break-word;
}

#tracker-settings .tracker-row-btns {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	flex-shrink: 0;
}

#tracker-settings .tracker-row-btns .btn {
	margin: 0;
}

/* Same separators as other label + input groups in settings cards */
#tracker-settings .tracker-form > .input + .setting-row-text {
	display: block;
	border-top: 1px solid #f0f1f2;
	border-top-color: color-mix(in srgb, var(--body-color) 6%, var(--window-bg-color));
	padding-top: 12px;
	margin-top: 10px;
}

#tracker-settings .tracker-form-btns {
	margin-top: 14px;
}

@media screen and (width <= 480px) {
	#tracker-settings .setting-row {
		flex-direction: column;
		gap: 8px;
	}
}
</style>

<script lang="ts">
import {computed, defineComponent, ref} from "vue";
import {useStore} from "../../js/store";
import SettingCard from "./SettingCard.vue";
import type {ClientNetwork} from "../../js/types";
import type {TrackerInfo} from "../../../shared/types/network";
import {
	isUsableProfileUrl,
	parseUserTracker,
	parseUserTrackers,
	serializeUserTrackers,
	type UserTracker,
	userTrackerLimits,
	userTrackersSetting,
} from "../../../shared/trackers";

type ServerTrackerItem = {
	key: string;
	network: ClientNetwork;
	host: string;
	tracker: TrackerInfo;
	entry?: UserTracker;
};

type Form = {
	mode: "new" | "edit" | "override";
	// The entry being edited, by network and id
	original?: {network: string; id: string};
	id: string;
	name: string;
	network: string;
	channels: string;
	profileUrl: string;
	userHost: string;
};

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isEntry = (entry: UserTracker, network: string, id: string) =>
	entry.network === network.toLowerCase() && sameId(entry.id, id);

export default defineComponent({
	name: "TrackerSettings",
	components: {
		SettingCard,
	},
	setup() {
		const store = useStore();
		const limits = userTrackerLimits;
		const form = ref<Form | null>(null);
		const formError = ref("");

		const entries = computed(() => parseUserTrackers(store.state.settings.userTrackers));

		// The user's networks by tracker key (which stands for the IRC server
		// host, see trackerKey); several networks can share one. `host` below
		// is always such a key, never a hostname.
		const networkHosts = computed(() => {
			const hosts = new Map<string, {host: string; label: string}>();

			for (const network of store.state.networks) {
				const host = network.trackerKey;

				if (host && !hosts.has(host)) {
					hosts.set(host, {host, label: network.name});
				}
			}

			return Array.from(hosts.values());
		});

		const serverTrackers = computed(() => {
			const items: ServerTrackerItem[] = [];
			const seen = new Set<string>();

			for (const network of store.state.networks) {
				const host = network.trackerKey;

				if (!host) {
					continue;
				}

				for (const tracker of network.trackers ?? []) {
					const key = `${host}\n${tracker.id.toLowerCase()}`;

					if (seen.has(key)) {
						continue;
					}

					seen.add(key);
					items.push({
						key,
						network,
						host,
						tracker,
						entry: entries.value.find((e) => isEntry(e, host, tracker.id)),
					});
				}
			}

			return items;
		});

		// Entries that aren't about one of the server's trackers shown above
		const ownTrackers = computed(() =>
			entries.value.filter((e) => !serverTrackers.value.some((item) => item.entry === e))
		);

		const hostIsListed = (host: string) => networkHosts.value.some((h) => h.host === host);

		const networkLabel = (host: string) =>
			networkHosts.value.find((h) => h.host === host)?.label ?? "A network you are not on";

		const saveEntries = (list: UserTracker[]) => {
			const value = serializeUserTrackers(list);

			if (value.length > userTrackerLimits.storedLength) {
				formError.value = "That is more than can be stored, remove some trackers first.";
				return false;
			}

			void store.dispatch("settings/update", {
				name: userTrackersSetting,
				value,
				sync: true,
			});
			return true;
		};

		const withoutEntry = (network: string, id: string) =>
			entries.value.filter((e) => !isEntry(e, network, id));

		const removeEntry = (entry: UserTracker) => {
			saveEntries(withoutEntry(entry.network, entry.id));
		};

		const hide = (item: ServerTrackerItem) => {
			saveEntries([
				...withoutEntry(item.host, item.tracker.id),
				{id: item.tracker.id, network: item.host, hidden: true},
			]);
		};

		const blankForm = {channels: "", profileUrl: "", userHost: ""};

		const addNew = () => {
			formError.value = "";
			form.value = {
				...blankForm,
				mode: "new",
				id: `user-${Date.now().toString(36)}`,
				name: "",
				network: networkHosts.value.length === 1 ? networkHosts.value[0].host : "",
			};
		};

		const editOwn = (entry: UserTracker) => {
			formError.value = "";
			form.value = {
				mode: "edit",
				original: {network: entry.network, id: entry.id},
				id: entry.id,
				name: entry.name ?? "",
				network: entry.network,
				channels: entry.channels?.join(", ") ?? "",
				profileUrl: entry.profileUrl ?? "",
				userHost: entry.userHost ?? "",
			};
		};

		const editOverride = (item: ServerTrackerItem) => {
			const current = item.entry?.hidden ? undefined : item.entry;
			formError.value = "";
			form.value = {
				...blankForm,
				mode: "override",
				original: item.entry ? {network: item.host, id: item.tracker.id} : undefined,
				id: item.tracker.id,
				name: item.tracker.name,
				network: item.host,
				profileUrl: current?.profileUrl ?? item.tracker.profileUrl ?? "",
				userHost: current?.userHost ?? item.tracker.userHost ?? "",
			};
		};

		const save = () => {
			const f = form.value;

			if (!f) {
				return;
			}

			const profileUrl = f.profileUrl.trim();

			if (f.mode !== "override" && !f.name.trim()) {
				formError.value = "Give the tracker a name.";
				return;
			}

			if (!f.network) {
				formError.value = "Choose the network the tracker is on.";
				return;
			}

			// The same check the server makes for the trackers in its config
			if (!isUsableProfileUrl(profileUrl) || profileUrl.length > userTrackerLimits.url) {
				formError.value =
					"The profile address has to start with http:// or https:// and contain {nick} or {ident}.";
				return;
			}

			const entry = parseUserTracker({
				id: f.id,
				network: f.network,
				name: f.mode === "override" ? undefined : f.name,
				channels:
					f.mode === "override"
						? undefined
						: f.channels.split(/[\s,]+/).filter((c) => c !== ""),
				profileUrl,
				userHost: f.userHost,
			});

			if (!entry?.profileUrl) {
				formError.value = "Some of the fields are too long.";
				return;
			}

			let list = entries.value;

			if (f.original) {
				list = list.filter((e) => !isEntry(e, f.original!.network, f.original!.id));
			}

			// Moving a tracker to a host where the same id is in use replaces it
			list = list.filter((e) => !isEntry(e, entry.network, entry.id));

			if (list.length >= userTrackerLimits.entries) {
				formError.value = `You can have at most ${userTrackerLimits.entries} entries.`;
				return;
			}

			if (saveEntries([...list, entry])) {
				form.value = null;
			}
		};

		return {
			limits,
			form,
			formError,
			networkHosts,
			serverTrackers,
			ownTrackers,
			hostIsListed,
			networkLabel,
			removeEntry,
			hide,
			addNew,
			editOwn,
			editOverride,
			save,
		};
	},
});
</script>
