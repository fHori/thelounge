import type {ClientUser} from "../types";

/**
 * The server sends the whole list whenever it changes. Users that are still
 * there with the same modes and away status keep their old object, so only
 * the rows that actually changed are drawn again (in a channel of thousands,
 * one join would otherwise redraw every row).
 */
export default function keepUnchangedUsers(previous: ClientUser[], incoming: ClientUser[]) {
	if (previous.length === 0) {
		return incoming;
	}

	const byNick = new Map(previous.map((user) => [user.nick, user]));

	return incoming.map((user) => {
		const old = byNick.get(user.nick);

		if (
			!old ||
			old.away !== user.away ||
			old.isBot !== user.isBot ||
			!sameModes(old.modes, user.modes)
		) {
			return user;
		}

		// Tracked in the browser too (autocomplete orders by it)
		if (user.lastMessage > old.lastMessage) {
			old.lastMessage = user.lastMessage;
		}

		return old;
	});
}

function sameModes(a: string[], b: string[]) {
	return a.length === b.length && a.every((mode, i) => mode === b[i]);
}
