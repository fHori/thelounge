import path from "node:path";
import {getDirname} from "./path-helper.js";

const __dirname = getDirname(import.meta.url);

const rootDir =
	process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development"
		? path.resolve(__dirname, "..")
		: path.resolve(__dirname, "..", "..");

export default function fromRoot(...fileName: string[]) {
	return path.resolve(rootDir, ...fileName);
}
