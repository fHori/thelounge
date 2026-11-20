import {defineConfig} from "vitest/config";
import type {Plugin} from "vite";
import vue from "@vitejs/plugin-vue";
import path from "path";

const noop = path.resolve(import.meta.dirname, "scripts/noop.js");
const clientSocket = path.resolve(import.meta.dirname, "client/js/socket.ts");

// The client tests don't talk to a server: like the old webpack test bundle,
// swap the socket.io connection (client/js/socket.ts) for a no-op so importing
// the store or chan.ts doesn't open a connection
function stubClientSocket(): Plugin {
	return {
		name: "stub-client-socket",
		enforce: "pre",
		async resolveId(source, importer, options) {
			if (!/socket(\.[jt]s)?$/.test(source)) {
				return null;
			}

			const resolved = await this.resolve(source, importer, {...options, skipSelf: true});
			return resolved?.id === clientSocket ? noop : null;
		},
	};
}

export default defineConfig({
	plugins: [vue()],
	resolve: {
		extensions: [".ts", ".js", ".vue"],
		alias: {
			debug: noop,
		},
	},
	define: {
		__VUE_PROD_DEVTOOLS__: false,
		__VUE_OPTIONS_API__: false,
	},
	test: {
		exclude: ["test/fixtures/**", "test/public/**", "test/util.ts", "**/node_modules/**"],
		// Sets the home folder to test/fixtures/.thelounge before any test runs
		setupFiles: ["test/fixtures/env.ts"],
		globals: true,
		testTimeout: 25000,
		coverage: {
			provider: "istanbul",
			include: ["client/**", "server/**", "shared/**", "defaults/**"],
			reporter: ["lcov", "text-summary"],
		},
		projects: [
			{
				extends: true,
				test: {
					name: "server",
					environment: "node",
					include: [
						"test/**/*Test.ts",
						"test/**/*test.ts",
						"test/tests/**/*.ts",
						"test/server.ts",
						"test/client.ts",
						"test/commands/**/*.ts",
						"test/models/**/*.ts",
						"test/plugins/**/*.ts",
						"test/shared/**/*.ts",
						"test/release/**/*.ts",
					],
					exclude: ["test/client/**"],
				},
			},
			{
				extends: true,
				plugins: [stubClientSocket()],
				test: {
					name: "client",
					// The old Mocha client run registered jsdom globally (global-jsdom)
					environment: "jsdom",
					include: ["test/client/**/*.ts"],
					exclude: ["test/client/index.ts"],
				},
			},
		],
	},
});
