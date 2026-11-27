import fs from "fs";
import path from "path";
import log from "../log.js";
import {Command} from "commander";
import ClientManager from "../clientManager.js";
import Config from "../config.js";
import Utils from "./utils.js";
import SqliteMessageStorage, {
	currentSchemaVersion,
	migrations,
	namedSchemaVersions,
} from "../plugins/messageStorage/sqlite.js";
import {StorageCleaner} from "../storageCleaner.js";

const program = new Command("storage").description(
	"various utilities related to the message storage"
);

program
	.command("migrate")
	.argument("[username]", "migrate a specific user only, all if not provided")
	.description("Migrate message storage where needed")
	.on("--help", Utils.extraHelp)
	.action(function (user) {
		runMigrations(user).catch((err) => {
			log.error(err.toString());
			process.exit(1);
		});
	});

program
	.command("clean")
	.argument("[user]", "clean messages for a specific user only, all if not provided")
	.description("Delete messages from the DB based on the storage policy")
	.on("--help", Utils.extraHelp)
	.action(function (user) {
		runCleaning(user).catch((err) => {
			log.error(err.toString());
			process.exit(1);
		});
	});

program
	.command("downgrade")
	.argument(
		"<version>",
		`schema version to go back to, or a name: "stock" (${namedSchemaVersions.stock}, stock The Lounge 4.5.x and the official Docker image), "stock-4.6" (${namedSchemaVersions["stock-4.6"]}, stock The Lounge 4.6.x) or "tetra" (${namedSchemaVersions.tetra}, stock 4.4.x and tetrahydroc/thelounge)`
	)
	.argument("[username]", "downgrade a specific user only, all if not provided")
	.description(
		"Undo message storage migrations so an older build can open the database again. Stop The Lounge first."
	)
	.on("--help", () => {
		log.raw("");
		log.raw("Schema versions this build knows about (newest last):");

		for (const m of migrations) {
			const notes = [
				m.version === namedSchemaVersions.stock ? "stock: The Lounge 4.5.x" : "",
				m.version === namedSchemaVersions["stock-4.6"] ? "stock-4.6: The Lounge 4.6.x" : "",
				m.version === namedSchemaVersions.tetra
					? "tetra: The Lounge 4.4.x, tetrahydroc"
					: "",
				m.version === currentSchemaVersion ? "current" : "",
			].filter(Boolean);

			log.raw(`  ${m.version}${notes.length ? ` (${notes.join(", ")})` : ""}`);
		}

		Utils.extraHelp();
	})
	.action(function (version: string, user?: string) {
		runDowngrades(version, user).catch((err) => {
			log.error(err.toString());
			process.exit(1);
		});
	});

async function runDowngrades(versionArg: string, user?: string) {
	const version = Object.hasOwn(namedSchemaVersions, versionArg)
		? namedSchemaVersions[versionArg as keyof typeof namedSchemaVersions]
		: Number(versionArg);

	if (!migrations.some((m) => m.version === version)) {
		throw new Error(
			`unknown schema version "${versionArg}", see \`thelounge storage downgrade --help\``
		);
	}

	const manager = new ClientManager();
	const users = manager.getUsers();

	if (user && !users.includes(user)) {
		throw new Error(`invalid user ${user}`);
	}

	log.warn("Make sure The Lounge is stopped, and that you have a backup of the logs folder.");

	for (const name of user ? [user] : users) {
		await downgradeUser(manager, name, version);
	}

	log.info(
		`Done. Starting this build again will migrate the databases forward to ${currentSchemaVersion}.`
	);
}

async function downgradeUser(manager: ClientManager, user: string, version: number) {
	log.info("handling user", user);

	// Don't create a database just to downgrade it
	if (!fs.existsSync(path.join(Config.getUserLogsPath(), `${user}.sqlite3`))) {
		log.info("no message database for", user, ". Skipping");
		return;
	}

	if (!isUserLogEnabled(manager, user)) {
		log.info("logging disabled for user", user, ". Skipping");
		return;
	}

	// Opened as is: migrating it forward first would only be undone again, and
	// on a large history that means rebuilding the search index for nothing
	const sqlite = new SqliteMessageStorage(user);
	await sqlite.open_without_migrating();

	try {
		const from = await sqlite.current_version();

		if (from === version) {
			log.info(user, "is already at", String(version));
			return;
		}

		await sqlite.downgrade_to(version);
		log.info("reclaiming space, this might take a while");
		await sqlite.vacuum();
		log.info(`downgraded ${user} from ${from} to ${version}`);
	} finally {
		await sqlite.close();
	}
}

program
	.command("vacuum")
	.argument("[username]", "vacuum a specific user only, all if not provided")
	.description(
		"Rewrite message databases to give unused space back to the disk. Stop The Lounge first."
	)
	.on("--help", Utils.extraHelp)
	.action(function (user) {
		runVacuum(user).catch((err) => {
			log.error(err.toString());
			process.exit(1);
		});
	});

async function runVacuum(user?: string) {
	const manager = new ClientManager();
	const users = manager.getUsers();

	if (user && !users.includes(user)) {
		throw new Error(`invalid user ${user}`);
	}

	log.warn(
		"Make sure The Lounge is stopped. Vacuuming needs as much free disk space as the database takes."
	);

	for (const name of user ? [user] : users) {
		await vacuumUser(manager, name);
	}
}

async function vacuumUser(manager: ClientManager, user: string) {
	const dbPath = path.join(Config.getUserLogsPath(), `${user}.sqlite3`);

	// Don't create a database just to vacuum it
	if (!fs.existsSync(dbPath)) {
		log.info("no message database for", user, ". Skipping");
		return;
	}

	if (!isUserLogEnabled(manager, user)) {
		log.info("logging disabled for user", user, ". Skipping");
		return;
	}

	const size = () =>
		[dbPath, `${dbPath}-wal`]
			.filter((f) => fs.existsSync(f))
			.reduce((sum, f) => sum + fs.statSync(f).size, 0);
	const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

	const before = size();
	const started = Date.now();
	log.info(`vacuuming ${user} (${mb(before)}), this might take a while`);

	const sqlite = new SqliteMessageStorage(user);
	await sqlite.enable(); // also runs any pending migrations
	await sqlite.vacuum();
	await sqlite.close();

	log.info(
		`vacuumed ${user}: ${mb(before)} -> ${mb(size())} in ${((Date.now() - started) / 1000).toFixed(1)}s`
	);
}

async function runMigrations(user?: string) {
	const manager = new ClientManager();
	const users = manager.getUsers();

	if (user) {
		if (!users.includes(user)) {
			throw new Error(`invalid user ${user}`);
		}

		return migrateUser(manager, user);
	}

	for (const name of users) {
		await migrateUser(manager, name);
		// if any migration fails we blow up,
		// chances are the rest won't complete either
	}
}

// runs sqlite migrations for a user, which must exist
async function migrateUser(manager: ClientManager, user: string) {
	log.info("handling user", user);

	if (!isUserLogEnabled(manager, user)) {
		log.info("logging disabled for user", user, ". Skipping");
		return;
	}

	const sqlite = new SqliteMessageStorage(user);
	await sqlite.enable(); // enable runs migrations

	// The server would build the search index in the background; there's
	// no one to keep waiting here, so finish it now
	if (!sqlite.searchIndexReady) {
		await sqlite.finishSearchIndex();
	}

	await sqlite.close();
	log.info("user", user, "migrated successfully");
}

function isUserLogEnabled(manager: ClientManager, user: string): boolean {
	const conf = manager.readUserConfig(user);

	if (!conf) {
		log.error("Could not open user configuration of", user);
		return false;
	}

	return conf.log;
}

async function runCleaning(user: string) {
	const manager = new ClientManager();
	const users = manager.getUsers();

	if (user) {
		if (!users.includes(user)) {
			throw new Error(`invalid user ${user}`);
		}

		return cleanUser(manager, user);
	}

	for (const name of users) {
		await cleanUser(manager, name);
		// if any migration fails we blow up,
		// chances are the rest won't complete either
	}
}

async function cleanUser(manager: ClientManager, user: string) {
	log.info("handling user", user);

	if (!isUserLogEnabled(manager, user)) {
		log.info("logging disabled for user", user, ". Skipping");
		return;
	}

	const sqlite = new SqliteMessageStorage(user);
	await sqlite.enable();
	const cleaner = new StorageCleaner(sqlite);
	const num_deleted = await cleaner.runDeletesNoLimit();
	log.info(`deleted ${num_deleted} messages`);
	log.info("running a vacuum now, this might take a while");

	if (num_deleted > 0) {
		await sqlite.vacuum();
	}

	await sqlite.close();
	log.info(`cleaning messages for ${user} has been successful`);
}

export default program;
