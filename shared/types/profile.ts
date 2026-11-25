// A user's profile, from WHOIS (see server/plugins/userIdentLookup.ts)
export type UserProfile = {
	nick: string;
	ident?: string;
	hostname?: string;
	realName?: string;
	account?: string;
	server?: string;
	serverInfo?: string;
	// Space-separated, with mode prefixes, as the server sends them
	channels?: string;
	away?: string;
	idle?: number; // seconds
	logon?: number; // unix time
	secure?: boolean;
	operator?: boolean;
	bot?: boolean;
	[key: string]: string | number | boolean | undefined;
};

// A link posted in a conversation, for its details page
export type ConversationLink = {
	url: string;
	msgId: number;
	time: number;
	from: string;
	preview?: import("./msg").LinkPreview;
};
