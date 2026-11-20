// Whether the user list draws an away dot next to each nick.
// Without away-notify the server only reports away state once, in the WHO reply
// on join, so with liveOnly set the dots are skipped there: they would go stale,
// and leaving them out saves two DOM nodes per user in big channels.
export default function shouldShowUserListStatus(
	enabled: boolean,
	liveOnly: boolean,
	serverHasAwayNotify: boolean | undefined
): boolean {
	return enabled && (!liveOnly || serverHasAwayNotify === true);
}
