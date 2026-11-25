import {defineConfig} from "vitepress";

const base = process.env.DOCS_BASE ?? "/";

export default defineConfig({
	title: "Horizon Lounge",
	description:
		"Fork of the popular client with tracker focused tweaks, better performance and a focus on expandability.",
	base,
	appearance: "force-dark",
	cleanUrls: false,
	lastUpdated: true,

	vite: {
		css: {
			postcss: {
				plugins: [],
			},
		},
	},

	head: [
		["link", {rel: "icon", type: "image/svg+xml", href: `${base}favicon.svg`}],
		["link", {rel: "preconnect", href: "https://fonts.googleapis.com"}],
		["link", {rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: ""}],
		[
			"link",
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&family=Geist:wght@400;500;600;700;800&display=swap",
			},
		],
	],

	themeConfig: {
		logo: "/logo.svg",
		siteTitle: "Horizon Lounge",

		nav: [
			{text: "Guide", link: "/getting-started"},
			{text: "Settings", link: "/settings/server"},
			{text: "Docker", link: "/DOCKER"},
			{text: "Credits", link: "/credits"},
		],

		sidebar: [
			{
				text: "Guide",
				items: [
					{text: "Getting started", link: "/getting-started"},
					{text: "What's different", link: "/features"},
					{text: "Docker", link: "/DOCKER"},
					{text: "Migrating", link: "/migrating"},
				],
			},
			{
				text: "Settings & Features",
				items: [
					{text: "Server configuration", link: "/settings/server"},
					{text: "Client settings", link: "/settings/client"},
					{text: "File uploads", link: "/settings/uploads"},
					{text: "Trackers & shoutbox", link: "/settings/trackers"},
					{text: "Search & chat features", link: "/settings/chat-features"},
				],
			},
			{
				text: "Theme Module API (Draft)",
				items: [
					{text: "Overview & manifest", link: "/theme-api/"},
					{text: "Server API v1", link: "/theme-api/server"},
					{text: "Client API v1", link: "/theme-api/client"},
					{text: "Versioning & security", link: "/theme-api/security"},
					{text: "Examples & extensions", link: "/theme-api/examples"},
				],
			},
			{
				text: "Project",
				items: [
					{text: "Credits", link: "/credits"},
					{text: "Releasing", link: "/RELEASING"},
				],
			},
		],

		search: {
			provider: "local",
		},

		socialLinks: [{icon: "github", link: "https://github.com/fHori/thelounge"}],

		editLink: {
			pattern: "https://github.com/fHori/thelounge/edit/master/docs/:path",
			text: "Edit this page on GitHub",
		},

		footer: {
			message: "MIT License",
			copyright: "Copyright © 2026 fHori",
		},
	},
});
