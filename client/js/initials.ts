/**
 * Initials for names, for themes that draw avatar circles: every nick shown in
 * the page gets `--tl-initials` ("BareMetal" → "BM", "sable" → "S") on its
 * `.user`, private-message row and DM header. Packages that provide avatar
 * pictures set `--tl-avatar` and clear `--tl-initials` (see the tracker
 * avatars package). The default theme uses neither.
 */

const style = document.createElement("style");
style.id = "tl-initials";
document.head.appendChild(style);

export const cssString = (s: string) =>
	s.replace(/["\\\n\r]/g, (c) => "\\" + c.charCodeAt(0).toString(16) + " ");

export function initialsFor(nick: string): string {
	const words = nick
		.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2") // camelCase → camel Case
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
	const letters = words.map((w) => w[0]).join("");
	return (letters || nick.slice(0, 1)).slice(0, 2).toUpperCase();
}

const knownNames = new Set<string>();
let queued = false;

function scanNames() {
	queued = false;
	let added = false;

	for (const el of document.querySelectorAll<HTMLElement>(
		'.user[data-name], .channel-list-item[data-type="query"][data-name], .header[data-name]'
	)) {
		const name = el.dataset.name;

		if (name && !knownNames.has(name.toLowerCase())) {
			knownNames.add(name.toLowerCase());
			added = true;
		}
	}

	if (!added) {
		return;
	}

	let css = "";

	for (const name of knownNames) {
		const n = cssString(name);
		css += `.user[data-name="${n}" i],.channel-list-item[data-type="query"][data-name="${n}" i],.header[data-name="${n}" i]{--tl-initials:"${cssString(initialsFor(name))}"}\n`;
	}

	style.textContent = css;
}

new MutationObserver(() => {
	if (!queued) {
		queued = true;
		setTimeout(scanNames, 300);
	}
}).observe(document.body, {childList: true, subtree: true});
