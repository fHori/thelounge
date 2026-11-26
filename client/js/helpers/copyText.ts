/**
 * Puts text on the clipboard. Must run from a click or tap. Returns false
 * when the browser allows neither way.
 *
 * navigator.clipboard only exists on https and localhost, and some installed
 * apps refuse it; the older execCommand("copy") of a selected text field
 * works on plain http too, iOS included.
 */
export default async function copyText(text: string): Promise<boolean> {
	if (window.isSecureContext && navigator.clipboard) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Fall through to the older way
		}
	}

	const field = document.createElement("textarea");
	field.value = text;
	field.setAttribute("readonly", "");
	// Off screen, and at least 16px so iOS doesn't zoom in on it
	field.style.position = "fixed";
	field.style.top = "-1000px";
	field.style.fontSize = "16px";
	document.body.appendChild(field);

	const active = document.activeElement as HTMLElement | null;

	try {
		field.focus();
		field.select();
		// select() alone selects nothing on iOS
		field.setSelectionRange(0, text.length);
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		field.remove();
		active?.focus();
	}
}
