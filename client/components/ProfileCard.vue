<template>
	<div class="profile-card" :data-name="nick">
		<div class="profile-banner" :class="nickColor" />
		<span class="user profile-avatar" :class="nickColor" :data-name="nick" aria-hidden="true" />
		<div class="profile-names">
			<div class="profile-nick">{{ nick }}</div>
			<div v-if="profile?.ident && profile?.hostname" class="profile-mask">
				{{ profile.ident }}@{{ profile.hostname }}
			</div>
		</div>
		<div v-if="badges.length" class="profile-badges">
			<span v-for="badge in badges" :key="badge" class="profile-badge">{{ badge }}</span>
		</div>

		<div v-if="entry.loading && !profile" class="profile-status">Looking them up…</div>
		<div v-else-if="!profile" class="profile-status">
			{{ isConnected ? "Not online right now." : "Not connected to the network." }}
		</div>

		<template v-if="profile">
			<section v-if="profile.away" class="profile-section">
				<h3>Away</h3>
				<p>{{ profile.away }}</p>
			</section>
			<section v-if="profile.realName" class="profile-section">
				<h3>Real name</h3>
				<p>{{ profile.realName }}</p>
			</section>
			<section v-if="profile.account" class="profile-section">
				<h3>Account</h3>
				<p>{{ profile.account }}</p>
			</section>
			<section v-if="profile.logon || profile.idle !== undefined" class="profile-section">
				<h3>Online since</h3>
				<p>
					<template v-if="profile.logon">{{ formatDate(profile.logon) }}</template>
					<template v-if="profile.idle !== undefined">
						<span class="profile-dim">
							{{ profile.logon ? " · " : "" }}idle
							{{ formatIdle(profile.idle) }}</span
						>
					</template>
				</p>
			</section>
			<section v-if="channels.length" class="profile-section">
				<h3>Channels</h3>
				<div class="profile-channels">
					<button
						v-for="chan in channels"
						:key="chan.name"
						type="button"
						class="profile-channel"
						:class="{shared: chan.shared}"
						:title="chan.shared ? `Open ${chan.name}` : `Join ${chan.name}`"
						@click="openChannel(chan.name)"
					>
						{{ chan.prefix }}{{ chan.name }}
					</button>
				</div>
			</section>
			<section v-if="profile.server" class="profile-section">
				<h3>Server</h3>
				<p>
					{{ profile.server
					}}<span v-if="profile.serverInfo" class="profile-dim">
						· {{ profile.serverInfo }}</span
					>
				</p>
			</section>
		</template>

		<div class="profile-actions">
			<button
				v-if="trackerProfile"
				type="button"
				class="btn profile-action"
				@click="openProfile"
			>
				View tracker profile
			</button>
			<button
				type="button"
				class="btn btn-small profile-action profile-refresh"
				:disabled="entry.loading || undefined"
				@click="refresh"
			>
				{{ entry.loading ? "Refreshing…" : "Refresh" }}
			</button>
		</div>
	</div>
</template>

<script lang="ts">
import {computed, defineComponent, PropType} from "vue";
import {getProfile} from "../js/profiles";
import {hasTrackerProfile, openTrackerProfile} from "../js/helpers/openTrackerProfile";
import colorClass from "../js/helpers/colorClass";
import socket from "../js/socket";
import {switchToChannel} from "../js/router";
import {ChanState, ChanType} from "../../shared/types/chan";
import type {ClientChan, ClientNetwork} from "../js/types";

export default defineComponent({
	name: "ProfileCard",
	props: {
		network: {type: Object as PropType<ClientNetwork>, required: true},
		channel: {type: Object as PropType<ClientChan>, required: true},
		nick: {type: String, required: true},
	},
	setup(props) {
		const entry = computed(() => getProfile(props.channel.id, props.nick));
		const profile = computed(() => entry.value.profile);
		const isConnected = computed(() => props.network.status.connected);
		const nickColor = computed(() => colorClass(props.nick));

		const badges = computed(() => {
			const p = profile.value;
			const list: string[] = [];

			if (p?.operator) {
				list.push("IRC operator");
			}

			if (p?.bot) {
				list.push("Bot");
			}

			if (p?.secure) {
				list.push("Secure connection");
			}

			if (p?.account) {
				list.push("Logged in");
			}

			return list;
		});

		// "@#dev +#help" → shared channels first
		const channels = computed(() => {
			const joined = new Set(
				props.network.channels
					.filter((c) => c.type === ChanType.CHANNEL && c.state === ChanState.JOINED)
					.map((c) => c.name.toLowerCase())
			);

			return (profile.value?.channels || "")
				.split(/\s+/)
				.filter(Boolean)
				.map((raw) => {
					const at = raw.search(/[#&!+]/);
					const name = at >= 0 ? raw.slice(at) : raw;
					const prefix = at > 0 ? raw.slice(0, at) : "";
					return {name, prefix, shared: joined.has(name.toLowerCase())};
				})
				.sort(
					(a, b) => Number(b.shared) - Number(a.shared) || a.name.localeCompare(b.name)
				);
		});

		const trackerProfile = computed(() =>
			hasTrackerProfile(props.network, props.channel, props.nick)
		);

		const openProfile = () => openTrackerProfile(props.network, props.channel, props.nick);
		const refresh = () => getProfile(props.channel.id, props.nick, true);

		const openChannel = (name: string) => {
			const existing = props.network.channels.find(
				(c) => c.name.toLowerCase() === name.toLowerCase()
			);

			if (existing && existing.state === ChanState.JOINED) {
				switchToChannel(existing);
			} else {
				socket.emit("input", {target: props.channel.id, text: `/join ${name}`});
			}
		};

		const formatDate = (unix: number) =>
			new Date(unix * 1000).toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			});

		const formatIdle = (seconds: number) => {
			if (seconds < 60) {
				return `${seconds}s`;
			}

			if (seconds < 3600) {
				return `${Math.floor(seconds / 60)}m`;
			}

			if (seconds < 86400) {
				return `${Math.floor(seconds / 3600)}h`;
			}

			return `${Math.floor(seconds / 86400)}d`;
		};

		return {
			entry,
			profile,
			isConnected,
			nickColor,
			badges,
			channels,
			trackerProfile,
			openProfile,
			refresh,
			openChannel,
			formatDate,
			formatIdle,
		};
	},
});
</script>
