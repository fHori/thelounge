import {SharedMention} from "./mention";
import {ChanState, SharedChan, UserGroup} from "./chan";
import {SharedNetwork, SharedServerOptions} from "./network";
import {SharedMsg, LinkPreview} from "./msg";
import {SharedUser} from "./user";
import {SharedChangelogData} from "./changelog";
import {SharedConfiguration, LockedSharedConfiguration} from "./config";
import {SearchRequest, SearchResultsChunk} from "./storage";

type Session = {
	current: boolean;
	active: number;
	lastUse: number;
	ip: string;
	agent: string;
	token: string;
};

type EventHandler<T> = (data: T) => void;
type NoPayloadEventHandler = EventHandler<void>;

interface ServerToClientEvents {
	"auth:start": (serverHash: number) => void;
	"auth:failed": (data?: {retryAfter: number}) => void;
	"auth:success": NoPayloadEventHandler;

	"upload:auth": (token: string) => void;

	changelog: EventHandler<SharedChangelogData>;
	"changelog:newversion": NoPayloadEventHandler;

	"channel:state": EventHandler<{chan: number; state: ChanState}>;
	"channel:groups": EventHandler<{chan: number; groups: UserGroup[]}>;

	"change-password": EventHandler<{success: boolean; error?: unknown}>;

	commands: EventHandler<string[]>;

	configuration: EventHandler<SharedConfiguration | LockedSharedConfiguration>;

	"push:issubscribed": EventHandler<boolean>;
	"push:unregister": NoPayloadEventHandler;

	"sessions:list": EventHandler<Session[]>;

	"mentions:list": EventHandler<SharedMention[]>;

	"setting:new": EventHandler<{name: string; value: unknown}>;
	"setting:all": EventHandler<{[key: string]: unknown}>;

	"history:clear": EventHandler<{target: number}>;

	"mute:changed": EventHandler<{target: number; status: boolean}>;
	"pin:changed": EventHandler<{target: number; status: boolean}>;
	// Answer to "tracker:user". Without ident and hostname if they couldn't be found out
	"tracker:user": EventHandler<{
		target: number;
		nick: string;
		ident?: string;
		hostname?: string;
	}>;

	names: EventHandler<{id: number; users: SharedUser[]}>;

	network: EventHandler<{network: SharedNetwork}>;
	"network:options": EventHandler<{network: string; serverOptions: SharedServerOptions}>;
	"network:status": EventHandler<{network: string; connected: boolean; secure: boolean}>;
	"network:info": EventHandler<{uuid: string}>;
	"network:name": EventHandler<{uuid: string; name: string}>;
	"network:trackers": EventHandler<{
		network: string;
		trackerKey: string;
		trackers?: SharedNetwork["trackers"];
	}>;

	nick: EventHandler<{network: string; nick: string}>;

	open: (id: number) => void;

	"channel:unread": EventHandler<{
		chan: number;
		unread: number;
		highlight: number;
		firstUnread: number;
	}>;

	part: EventHandler<{chan: number}>;

	"sign-out": NoPayloadEventHandler;

	"sync_sort:networks": EventHandler<{order: SharedNetwork["uuid"][]}>;
	"sync_sort:channels": EventHandler<{
		network: SharedNetwork["uuid"];
		order: SharedChan["id"][];
	}>;

	topic: EventHandler<{chan: number; topic: string}>;

	users: EventHandler<{chan: number}>;

	more: EventHandler<{
		chan: number;
		messages: SharedMsg[];
		totalMessages: number;
		hasMore: boolean;
	}>;

	"messages:around": EventHandler<{
		chan: number;
		// The time that was asked for
		time?: number;
		messages: SharedMsg[];
		hasMoreBefore: boolean;
		hasMoreAfter: boolean;
	}>;

	"messages:after": EventHandler<{chan: number; messages: SharedMsg[]; hasMore: boolean}>;

	"msg:preview": EventHandler<{id: number; chan: number; preview: LinkPreview}>;
	"msg:special": EventHandler<{chan: number; data?: unknown}>;
	msg: EventHandler<{msg: SharedMsg; chan: number; highlight?: number; unread?: number}>;

	init: EventHandler<{active: number; networks: SharedNetwork[]; token?: string}>;

	"search:results": EventHandler<SearchResultsChunk>;

	quit: EventHandler<{network: string}>;

	error: (error: unknown) => void;

	connecting: NoPayloadEventHandler;

	join: EventHandler<{
		shouldOpen: boolean;
		index: number;
		network: string;
		chan: SharedNetworkChan;
	}>;
}

type AuthPerformData =
	| Record<string, never> // funny way of saying an empty object
	| {user: string; password: string}
	| {
			user: string;
			token: string;
			lastMessage: number;
			openChannel: number | null;
			hasConfig: boolean;
			visible?: boolean;
	  };

interface ClientToServerEvents {
	"auth:perform": EventHandler<AuthPerformData>;

	changelog: NoPayloadEventHandler;

	"change-password": EventHandler<{
		old_password: string;
		new_password: string;
		verify_password: string;
	}>;

	open: (channelId: number) => void;

	// Whether the browser tab is on screen, as opposed to in the background
	"window:visible": (visible: boolean) => void;

	names: EventHandler<{target: number}>;

	input: EventHandler<{target: number; text: string}>;

	"upload:auth": NoPayloadEventHandler;
	"upload:ping": (token: string) => void;

	"mute:change": EventHandler<{target: number; setMutedTo: boolean}>;
	"pin:change": EventHandler<{target: number; setPinnedTo: boolean}>;
	"tracker:user": EventHandler<{target: number; nick: string}>;

	"push:register": EventHandler<PushSubscriptionJSON>;
	"push:unregister": NoPayloadEventHandler;

	"setting:get": NoPayloadEventHandler;
	"setting:set": EventHandler<{name: string; value: unknown}>;

	"sessions:get": NoPayloadEventHandler;

	"sort:networks": EventHandler<{order: SharedNetwork["uuid"][]}>;
	"sort:channels": EventHandler<{
		network: SharedNetwork["uuid"];
		order: SharedChan["id"][];
	}>;

	"mentions:dismiss": (msgId: number) => void;
	"mentions:dismiss_all": NoPayloadEventHandler;
	"mentions:get": NoPayloadEventHandler;

	more: EventHandler<{
		target: number;
		lastId: number;
		// Time of the message `lastId` refers to. Ids are not unique across
		// a channel's history, id and time together are
		lastTime?: number;
		condensed: boolean;
		// Time of the oldest message the client holds, used to page from
		// storage once the server no longer has that message in memory
		beforeTime?: number;
	}>;

	"messages:around": EventHandler<{target: number; time: number}>;

	"messages:after": EventHandler<{target: number; afterTime: number}>;

	"msg:preview:toggle": EventHandler<{
		target: number;
		messageIds?: number[];
		msgId?: number;
		shown?: boolean | null;
		link?: string;
	}>;

	"network:get": (uuid: string) => void;
	// TODO typing
	"network:edit": (data: Record<string, unknown>) => void;
	"network:new": (data: Record<string, unknown>) => void;

	"sign-out": (token?: string) => void;

	"history:clear": EventHandler<{target: number}>;

	search: EventHandler<SearchRequest>;
	"search:cancel": EventHandler<number>;
}

// Socket.IO requires these interfaces to be defined even if empty
// Using Record<string, never> to explicitly indicate no events/data are defined
type InterServerEvents = Record<string, never>;

type SocketData = Record<string, never>;
