import type {ThemeOptions} from "../themeOptions";

export type ConfigTheme = {
	displayName: string;
	name: string;
	themeColor: string | null;
	options?: ThemeOptions;
	features?: import("../features").FeatureValues;
	client?: string;
	recommends?: {name: string; description?: string; install?: string; installed?: boolean}[];
	author?: string;
	repositoryUrl?: string;
};
type SharedConfigurationBase = {
	public: boolean;
	useHexIp: boolean;
	prefetch: boolean;
	fileUpload: boolean;
	ldapEnabled: boolean;
	isUpdateAvailable: boolean;
	applicationServerKey: string;
	version: string;
	gitCommit: string | null;
	themes: ConfigTheme[];
	// Client modules of non-theme packages (theme modules come with their theme)
	packageModules?: {name: string; client: string}[];
	defaultTheme: string;
	fileUploadMaxFileSize?: number;
	// GIF picker provider, null when GIFs are off
	gifs?: "giphy" | "tenor" | null;
	allowFileUploadBackendSelection?: boolean;
	maskFileHost?: boolean;
};

export type ConfigNetDefaults = {
	name: string;
	host: string;
	port: number;
	password: string;
	tls: boolean;
	rejectUnauthorized: boolean;
	nick: string;
	username: string;
	realname: string;
	join: string;
	leaveMessage: string;
	sasl: string;
	saslAccount: string;
	saslPassword: string;
};
export type LockedConfigNetDefaults = Omit<
	ConfigNetDefaults,
	"host" | "port" | "tls" | "rejectUnauthorized"
>;

export type LockedSharedConfiguration = SharedConfigurationBase & {
	lockNetwork: true;
	defaults: LockedConfigNetDefaults;
};

export type SharedConfiguration = SharedConfigurationBase & {
	lockNetwork: false;
	defaults: ConfigNetDefaults;
};
