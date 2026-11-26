import os from "node:os";
import {Worker} from "node:worker_threads";
import bcrypt from "bcryptjs";

// bcryptjs is pure JS: even its async API runs on the event loop, in chunks
// of ~100 ms per hash at 11 rounds. Hash and compare in worker threads so a
// burst of logins can't stall every connected client.

const ROUNDS = 11;
const IDLE_MS = 60 * 1000;

// Plain CommonJS so it runs the same from tsx (tests) and the compiled build
const workerSource = `
const {parentPort, workerData} = require("node:worker_threads");
const bcrypt = require("node:module").createRequire(workerData.base)("bcryptjs");

parentPort.on("message", (job) => {
	try {
		const result =
			job.op === "compare"
				? bcrypt.compareSync(job.password, job.hash)
				: bcrypt.hashSync(job.password, job.rounds);
		parentPort.postMessage({result});
	} catch (error) {
		parentPort.postMessage({error: String((error && error.message) || error)});
	}
});
`;

type Job = {
	message:
		| {op: "compare"; password: string; hash: string}
		| {op: "hash"; password: string; rounds: number};
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

type PoolWorker = {
	worker: Worker;
	job: Job | null;
};

const size = Math.max(1, Math.min(2, os.availableParallelism() - 1));
const workers: PoolWorker[] = [];
const queue: Job[] = [];
let idleTimer: NodeJS.Timeout | null = null;
let workersUnavailable = false;

function spawn(): PoolWorker | null {
	let worker: Worker;

	try {
		worker = new Worker(workerSource, {eval: true, workerData: {base: import.meta.url}});
	} catch {
		workersUnavailable = true;
		return null;
	}

	const entry: PoolWorker = {worker, job: null};

	worker.on("message", (reply: {result?: unknown; error?: string}) => {
		const job = entry.job;
		entry.job = null;
		worker.unref();

		if (job) {
			if (reply.error !== undefined) {
				job.reject(new Error(reply.error));
			} else {
				job.resolve(reply.result);
			}
		}

		pump();
	});

	const drop = (error: Error) => {
		const index = workers.indexOf(entry);

		if (index === -1) {
			return;
		}

		workers.splice(index, 1);
		entry.job?.reject(error);
		entry.job = null;
		pump();
	};

	worker.on("error", drop);
	worker.on("exit", (code) => drop(new Error(`Password worker exited with code ${code}`)));
	worker.unref();
	workers.push(entry);
	return entry;
}

function pump() {
	while (queue.length > 0) {
		let entry = workers.find((w) => w.job === null);

		if (!entry && workers.length < size) {
			entry = spawn() ?? undefined;

			if (!entry && workersUnavailable) {
				runOnMainThread();
				return;
			}
		}

		if (!entry) {
			break;
		}

		const job = queue.shift()!;
		entry.job = job;
		entry.worker.ref();
		entry.worker.postMessage(job.message);
	}

	scheduleIdleShutdown();
}

function scheduleIdleShutdown() {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}

	if (workers.length === 0 || workers.some((w) => w.job) || queue.length > 0) {
		return;
	}

	idleTimer = setTimeout(() => {
		idleTimer = null;
		void terminatePasswordWorkers();
	}, IDLE_MS);
	idleTimer.unref();
}

// Only reached if this Node.js build can't start workers at all
function runOnMainThread() {
	for (const job of queue.splice(0)) {
		const message = job.message;
		const result =
			message.op === "compare"
				? bcrypt.compare(message.password, message.hash)
				: bcrypt.hash(message.password, message.rounds);
		result.then(job.resolve, job.reject);
	}
}

function run<T>(message: Job["message"]): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		queue.push({message, resolve: resolve as (value: unknown) => void, reject});
		pump();
	});
}

export function passwordCompare(password: string, expected: string): Promise<boolean> {
	if (typeof password !== "string" || typeof expected !== "string") {
		return Promise.resolve(false);
	}

	return run<boolean>({op: "compare", password, hash: expected});
}

export function passwordHash(password: string): Promise<string> {
	return run<string>({op: "hash", password, rounds: ROUNDS});
}

// For the command line tools, which run outside the server process
export function passwordHashSync(password: string) {
	return bcrypt.hashSync(password, bcrypt.genSaltSync(ROUNDS));
}

export function passwordRequiresUpdate(password: string) {
	return bcrypt.getRounds(password) !== ROUNDS;
}

export async function terminatePasswordWorkers() {
	const all = workers.splice(0);
	await Promise.all(all.map((w) => w.worker.terminate()));
}

export function passwordWorkerCount() {
	return workers.length;
}
