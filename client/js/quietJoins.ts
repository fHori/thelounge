/**
 * Windows opened or updated in the background for a short while: channels joined
 * from a channel browser, and channel lists Discover asks for. Their joins and
 * list updates don't take the user away from where they are (see
 * socket-events/join.ts and msg_special.ts).
 */

const quiet = new Map<string, number>(); // `${network uuid} ${channel lowercased}` → expiry

const key = (network: string, channel: string) => `${network} ${channel.toLowerCase()}`;

export function joinQuietly(network: string, channel: string, forMs = 30000) {
	quiet.set(key(network, channel), Date.now() + forMs);
}

/** Whether this window should stay in the background right now. */
export function isQuiet(network: string, channel: string): boolean {
	const k = key(network, channel);
	const expiry = quiet.get(k);

	if (expiry !== undefined && expiry <= Date.now()) {
		quiet.delete(k);
		return false;
	}

	return expiry !== undefined;
}
