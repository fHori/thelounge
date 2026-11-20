import * as path from "path";
import {fileURLToPath} from "url";
import config from "../../server/config.js";
import log from "../../server/log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const home = path.join(__dirname, ".thelounge");

// Vitest setup file (vitest.config.mts): awaited so every test file starts with
// the fixture home loaded
try {
	await config.setHome(home);
} catch (err) {
	log.error("Failed to set home directory:", String(err));
	throw err;
}
