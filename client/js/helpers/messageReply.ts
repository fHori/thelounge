import eventbus from "../eventbus";
import type {ContextMenuItem} from "./contextMenu";

type ReplySettings = {
	enableReplyToMessage?: boolean;
	replyToMessagePlainText?: boolean;
};

type ReplyMessage = {
	from?: {nick?: string};
	text?: string;
};

// `shown` is the message as displayed (bridged messages are rewritten),
// `original` the one the server sent.
export function canReplyToMessage(
	settings: ReplySettings,
	shown: ReplyMessage,
	original: ReplyMessage = shown
): boolean {
	if (settings.enableReplyToMessage === false) {
		return false;
	}

	return Boolean(shown.from?.nick && original.text);
}

export function replyText(settings: ReplySettings, shown: ReplyMessage): string | null {
	const nick = shown.from?.nick;
	const content = shown.text;

	if (!nick || !content) {
		return null;
	}

	return settings.replyToMessagePlainText
		? `${nick}: (re: "${content}") `
		: `\x02${nick}\x02: \x0314,99"\x1D${content}\x1D"\x03 `;
}

export function replyToMessage(settings: ReplySettings, shown: ReplyMessage) {
	const text = replyText(settings, shown);

	if (text) {
		eventbus.emit("message:reply", text);
	}
}

export function generateMessageContextMenu(
	settings: ReplySettings,
	shown: ReplyMessage,
	original: ReplyMessage = shown
): ContextMenuItem[] {
	if (!canReplyToMessage(settings, shown, original)) {
		return [];
	}

	return [
		{
			label: "Reply",
			type: "item",
			class: "reply",
			action() {
				replyToMessage(settings, shown);
			},
		},
	];
}
