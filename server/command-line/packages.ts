import log from "../log.js";
import colors from "chalk";
import fs from "node:fs";
import path from "node:path";
import {Command} from "commander";
import Config from "../config.js";
import Utils from "./utils.js";
import {allowedPackages, setAllowed, wantsAdvancedApi} from "../plugins/packages/advanced.js";

/**
 * `thelounge packages allow|deny|list`: which installed packages may run server
 * code with the advanced package API. Takes effect when The Lounge restarts.
 */

function installedPackageJson(name: string): Record<string, unknown> | null {
	try {
		return JSON.parse(
			fs.readFileSync(path.join(Config.getPackageModulePath(name), "package.json"), "utf-8")
		) as Record<string, unknown>;
	} catch {
		return null;
	}
}

const program = new Command("packages").description(
	"Allow or deny packages running server code with the advanced package API"
);

program
	.command("allow")
	.argument("<package>", "name of an installed package")
	.description("Let a package run its server code")
	.on("--help", Utils.extraHelp)
	.action((name: string) => {
		const json = installedPackageJson(name);

		if (!json) {
			log.error(`${colors.red(name)} is not installed.`);
			process.exitCode = 1;
			return;
		}

		setAllowed(name, true);
		log.info(
			`${colors.green(name)} may now run server code with full access. Restart The Lounge to start it.`
		);

		if (!wantsAdvancedApi(json.thelounge)) {
			log.info(
				`(${name} doesn't ask for the advanced API, so this changes nothing for now.)`
			);
		}
	});

program
	.command("deny")
	.argument("<package>", "name of a package")
	.description("Stop a package running its server code")
	.on("--help", Utils.extraHelp)
	.action((name: string) => {
		setAllowed(name, false);
		log.info(
			`${colors.green(name)} won't run server code. Restart The Lounge for this to apply.`
		);
	});

program
	.command("list")
	.description("List packages allowed to run server code")
	.on("--help", Utils.extraHelp)
	.action(() => {
		const list = allowedPackages();
		log.info(
			list.length
				? `Allowed: ${list.join(", ")}`
				: "No packages are allowed to run server code."
		);
	});

export default program;
