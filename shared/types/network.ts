import {SharedChan} from "./chan";

export type SharedPrefixObject = {
	symbol: string;
	mode: string;
};

export type SharedNetworkChan = SharedChan & {
	totalMessages: number;
	// False until the server has read this channel's stored history, which
	// happens the first time the channel is opened.
	historyLoaded: boolean;
};

export type SharedPrefix = {
	prefix: SharedPrefixObject[];
	modeToSymbol: {[mode: string]: string};
	symbols: string[];
};

export type SharedServerOptions = {
	CHANTYPES: string[];
	PREFIX: SharedPrefix;
	NETWORK: string;
	supportsReply: boolean;
	MONITOR: number | null;
};

export type SharedNetworkStatus = {
	connected: boolean;
	secure: boolean;
};

export type SharedNetwork = {
	uuid: string;
	name: string;
	// Key for the IRC network (its server host, plus the network the login
	// picks on a bouncer), which trackers in the user's settings are tied
	// to. Derived with a server secret, the host itself isn't sent.
	trackerKey: string;
	nick: string;
	serverOptions: SharedServerOptions;
	status: SharedNetworkStatus;
	channels: SharedNetworkChan[];
	// Trackers whose users chat on this network, if any
	trackers?: TrackerInfo[];
};

// A tracker whose users chat on an IRC network, as written in config.js
// `trackers` (keyed by id). Used for "Tracker Profile" links in the user
// context menu, and to limit shoutbox bridge matchers to the tracker's own
// network and channels.
export type TrackerConfig = {
	name?: string;
	// IRC server hostname, compared case-insensitively against the network host
	network?: string;
	// The tracker's channels (case-insensitive). Omit for the whole network.
	channels?: string[];
	// Address of a user's profile, with `{nick}` where the nick goes, or
	// `{ident}` for trackers whose IRC server puts the user id in the ident
	profileUrl?: string;
	// What the hostname of the tracker's users looks like, `*` for any text.
	// Only checked for `{ident}` addresses.
	userHost?: string;
	disabled?: boolean;
};

// The older `torrentSites` list entry, still read from existing configs
export type LegacyTorrentSite = {
	disabled?: boolean;
	abbreviation: string;
	name: string;
	host: string;
	domain: string;
	channels?: string[];
	profileUrl?: string;
	profileLink?: boolean;
};

// A tracker as sent to the client for a network it applies to
export type TrackerInfo = {
	id: string;
	name: string;
	channels?: string[];
	// Absent when the tracker has no usable profile address
	profileUrl?: string;
	userHost?: string;
};

// The placeholders in `profileUrl` are in shared/trackers.ts
