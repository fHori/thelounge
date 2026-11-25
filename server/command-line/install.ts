import log from "../log.js";
import colors from "chalk";
import semver from "semver";
import Helper from "../helper.js";
import Config from "../config.js";
import Utils from "./utils.js";
import {Command} from "commander";
import packageJsonImport from "package-json";
import fs from "node:fs";
import fspromises from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import {setAllowed, wantsAdvancedApi} from "../plugins/packages/advanced.js";
import {parseRecommends} from "../plugins/packages/themes.js";

interface CustomMetadata {
	name: string;
	version?: string;
	thelounge?: {
		supports?: string;
		api?: unknown;
		recommends?: unknown;
	};
	author?: unknown;
	repository?: unknown;
}

const program = new Command("install");
program
	.argument(
		"<package>",
		"package to install. Use `file:$path_to_package_dir` to install a local package"
	)
	.description("Install a theme or a package")
	.option(
		"--allow-server-code",
		"allow the package to run server code (advanced package API) without asking"
	)
	.on("--help", Utils.extraHelp)
	.action(function (packageName: string, options: {allowServerCode?: boolean}) {
		if (!fs.existsSync(Config.getConfigPath())) {
			log.error(`${Config.getConfigPath()} does not exist.`);
			return;
		}

		log.info("Retrieving information about the package...");

		let readFile: Promise<CustomMetadata>;
		let isLocalFile = false;
		let packageVersion = "latest";

		if (packageName.startsWith("file:")) {
			isLocalFile = true;
			// our yarn invocation sets $HOME to the cachedir, so we must expand ~ now
			// else the path will be invalid when npm expands it.
			packageName = expandTildeInLocalPath(packageName);
			readFile = fspromises
				.readFile(path.join(packageName.substring("file:".length), "package.json"), "utf-8")
				.then((data): CustomMetadata => JSON.parse(data) as CustomMetadata);
		} else {
			// properly split scoped and non-scoped npm packages
			// into their name and version
			const atIndex = packageName.indexOf("@", 1);

			if (atIndex !== -1) {
				packageVersion = packageName.slice(atIndex + 1);
				packageName = packageName.slice(0, atIndex);
			}

			readFile = packageJsonImport(packageName, {
				fullMetadata: true,
				version: packageVersion,
			});
		}

		readFile
			.then((json: CustomMetadata) => {
				const version = json.version || packageVersion;
				const humanVersion = isLocalFile ? packageName : `${json.name} v${version}`;

				if (!json.thelounge) {
					log.error(`${colors.red(humanVersion)} does not have The Lounge metadata.`);

					process.exit(1);
				}

				if (
					json.thelounge.supports &&
					!semver.satisfies(Helper.getVersionNumber(), json.thelounge.supports, {
						includePrerelease: true,
					})
				) {
					log.error(
						`${colors.red(
							humanVersion
						)} does not support The Lounge v${Helper.getVersionNumber()}. Supported version(s): ${
							json.thelounge.supports
						}`
					);

					process.exit(2);
				}

				const wantsServer = wantsAdvancedApi(json.thelounge);

				return (
					wantsServer
						? askToAllow(json, humanVersion, Boolean(options.allowServerCode))
						: Promise.resolve(false)
				).then((allowed) => install(json, version, humanVersion, wantsServer, allowed));
			})
			.catch((e) => {
				log.error(`${e}`);
				process.exit(1);
			});

		function install(
			json: CustomMetadata,
			version: string,
			humanVersion: string,
			wantsServer: boolean,
			allowed: boolean
		) {
			log.info(`Installing ${colors.green(humanVersion)}...`);
			const yarnVersion = isLocalFile ? packageName : `${json.name}@${version}`;
			return Utils.executeYarnCommand("add", "--exact", yarnVersion)
				.then(() => {
					log.info(`${colors.green(humanVersion)} has been successfully installed.`);

					if (isLocalFile) {
						// yarn v1 is buggy if a local filepath is used and doesn't update
						// the lockfile properly. We need to run an install in that case
						// even though that's supposed to be done by the add subcommand
						return Utils.executeYarnCommand("install").catch((err) => {
							throw new Error(
								`Failed to update lockfile after package install ${err}`
							);
						});
					}
				})
				.then(() => {
					// Packages that go well with this one (never installed automatically)
					for (const rec of parseRecommends(json.thelounge?.recommends)) {
						if (fs.existsSync(Config.getPackageModulePath(rec.name))) {
							continue;
						}

						log.info(
							`${json.name} recommends ${colors.bold(rec.name)}${
								rec.description ? ` (${rec.description})` : ""
							}: ${colors.green(rec.install || `thelounge install ${rec.name}`)}`
						);
					}

					if (!wantsServer) {
						return;
					}

					setAllowed(json.name, allowed);
					log.info(
						allowed
							? `${json.name} may run server code. Restart The Lounge to start it.`
							: `${json.name} won't run server code. Allow it later with: thelounge packages allow ${json.name}`
					);
				})
				.catch((code) => {
					throw new Error(
						`Failed to install ${colors.red(humanVersion)}. Exit code: ${code}`
					);
				});
		}
	});

/** Asks the admin whether a package may run server code (the advanced package API). */
async function askToAllow(json: CustomMetadata, humanVersion: string, preApproved: boolean) {
	const by =
		typeof json.author === "string" ? json.author : (json.author as {name?: string})?.name;
	const source =
		typeof json.repository === "string"
			? json.repository
			: (json.repository as {url?: string} | undefined)?.url;

	log.warn(
		`${colors.bold(humanVersion)}${by ? ` by ${by}` : ""} wants to run server code with full access to The Lounge.` +
			(source ? ` Source: ${source}` : "")
	);

	if (preApproved) {
		return true;
	}

	if (!process.stdin.isTTY) {
		log.info("Not asking (no terminal); it won't run server code unless allowed later.");
		return false;
	}

	const rl = readline.createInterface({input: process.stdin, output: process.stdout});
	const answer = await new Promise<string>((resolve) => rl.question("Allow it? [y/N] ", resolve));
	rl.close();
	return /^y(es)?$/i.test(answer.trim());
}

function expandTildeInLocalPath(packageName: string): string {
	const localPath = packageName.substring("file:".length);
	return "file:" + Helper.expandHome(localPath);
}

export default program;
