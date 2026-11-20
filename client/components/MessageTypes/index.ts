import type {Component} from "vue";

const modules = import.meta.glob<{default: Component}>("./*.vue", {eager: true});

export default Object.fromEntries(
	Object.entries(modules).map(([path, mod]) => ["message-" + path.slice(2, -4), mod.default])
);
