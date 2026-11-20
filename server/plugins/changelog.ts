import colors from "../colors.js";
import semver from "semver";
import log from "../log.js";
import pkg from "../../package.json" with {type: "json"};
import ClientManager from "../clientManager.js";
import outgoingFetch from "./outgoingFetch.js";
import {SharedChangelogData} from "../../shared/types/changelog.js";

const TIME_TO_LIVE = 15 * 60 * 1000; // 15 minutes, in milliseconds

// This fork is versioned and released independently of the stock project, so
// update checks and release links must use this fork's own GitHub releases.
// A stock release would lack this fork's features and cannot open a database
// this fork has upgraded.
export const RELEASES_REPOSITORY = "fHori/thelounge";
export const RELEASES_PAGE_URL = `https://github.com/${RELEASES_REPOSITORY}/releases`;
const RELEASES_API_URL = `https://api.github.com/repos/${RELEASES_REPOSITORY}/releases`;

let updateCheckTimeout: NodeJS.Timeout | null = null;

const changelog = {
	isUpdateAvailable: false,
	fetch,
	checkForUpdates,
	stopUpdateChecks,
};

export default changelog;
const versions: SharedChangelogData = {
	current: {
		prerelease: false,
		version: `v${pkg.version}`,
		changelog: undefined,
		url: RELEASES_PAGE_URL,
	},
	expiresAt: -1,
	latest: undefined,
	packages: undefined,
};

async function fetch() {
	const time = Date.now();

	// Serving information from cache
	if (versions.expiresAt > time) {
		return versions;
	}

	try {
		const fetchOptions: RequestInit = {
			headers: {
				Accept: "application/vnd.github.v3.html", // Request rendered markdown
				"User-Agent": `${pkg.name}; +https://github.com/${RELEASES_REPOSITORY}`, // Identify the client
			},
			signal: AbortSignal.timeout(15 * 1000),
		};

		const response = await outgoingFetch(RELEASES_API_URL, fetchOptions);

		if (response.status !== 200) {
			return versions;
		}

		const body = await response.text();
		updateVersions(body);

		// Add expiration date to the data to send to the client for later refresh
		versions.expiresAt = time + TIME_TO_LIVE;
	} catch (error) {
		// eslint-disable-next-line @typescript-eslint/restrict-template-expressions
		log.error(`Failed to fetch changelog: ${error}`);
	}

	return versions;
}

type GitHubRelease = {
	tag_name: string;
	body_html?: string;
	prerelease: boolean;
	draft?: boolean;
	html_url: string;
};

function isRelease(release: unknown): release is GitHubRelease {
	if (!release || typeof release !== "object") {
		return false;
	}

	const r = release as Record<string, unknown>;

	return (
		typeof r.tag_name === "string" &&
		typeof r.html_url === "string" &&
		typeof r.prerelease === "boolean" &&
		r.draft !== true
	);
}

// Exported for tests
export function updateVersions(responseBody: string): SharedChangelogData {
	const body: unknown = JSON.parse(responseBody);
	const releases = Array.isArray(body) ? body.filter(isRelease) : [];

	versions.current.changelog = undefined;
	versions.current.url = RELEASES_PAGE_URL;
	versions.latest = undefined;
	changelog.isUpdateAvailable = false;

	// Find the current release among the releases on GitHub. A fork without
	// releases (or without a release for this version) is simply up to date.
	const current = releases.find((release) => release.tag_name === versions.current.version);

	const currentVersion = semver.valid(versions.current.version);

	versions.current.prerelease = current
		? current.prerelease
		: Boolean(currentVersion && semver.prerelease(currentVersion));

	if (current) {
		versions.current.changelog = current.body_html;
		versions.current.url = current.html_url;
	}

	if (!currentVersion) {
		return versions;
	}

	// Find the newest release that is newer than the current version. Only
	// offer pre-releases if the current version is a pre-release as well.
	// Compare versions instead of relying on list order, so an older release
	// is never presented as an update.
	for (const release of releases) {
		const version = semver.valid(release.tag_name);

		if (!version || !semver.gt(version, currentVersion)) {
			continue;
		}

		if (release.prerelease && !versions.current.prerelease) {
			continue;
		}

		if (!versions.latest || semver.gt(version, versions.latest.version)) {
			versions.latest = {
				prerelease: release.prerelease,
				version: release.tag_name,
				url: release.html_url,
			};
		}
	}

	changelog.isUpdateAvailable = Boolean(versions.latest);

	return versions;
}

function checkForUpdates(manager: ClientManager) {
	fetch()
		.then((versionData) => {
			if (!changelog.isUpdateAvailable) {
				// Check for updates every 24 hours + random jitter of <3 hours
				updateCheckTimeout = setTimeout(
					() => checkForUpdates(manager),
					24 * 3600 * 1000 + Math.floor(Math.random() * 10000000)
				);
			}

			if (!versionData.latest) {
				return;
			}

			log.info(
				`The Lounge ${colors.green(
					versionData.latest.version
				)} is available. Read more on GitHub: ${versionData.latest.url}`
			);

			// Notify all connected clients about the new version
			manager.clients.forEach((client) => client.emit("changelog:newversion"));
		})
		.catch((error: Error) => {
			log.error(`Failed to check for updates: ${error.message}`);
		});
}

function stopUpdateChecks() {
	if (updateCheckTimeout) {
		clearTimeout(updateCheckTimeout);
		updateCheckTimeout = null;
	}
}
