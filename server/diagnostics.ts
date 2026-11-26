// Facts about the server for the diagnostics page. Nothing here identifies
// anyone: no addresses, host names, paths, user, network or channel names.
import fs from "fs";
import os from "os";
import {monitorEventLoopDelay} from "perf_hooks";
import Config from "./config.js";
import Helper from "./helper.js";
import type Client from "./client.js";
import type {ServerDiagnostics, UserDiagnostics} from "../shared/types/storage.js";

// Delay of the server's own thread, since the last time it was read
const loopDelay = monitorEventLoopDelay({resolution: 20});
loopDelay.enable();

// Linux statfs f_type values of filesystems worth telling apart. Network and
// virtual machine shares are the usual reason a database is slow.
const fsTypes: Record<number, string> = {
	0xef53: "ext4",
	0x58465342: "xfs",
	0x9123683e: "btrfs",
	0x2fc12fc1: "zfs",
	0x01021994: "tmpfs",
	0x794c7630: "overlayfs",
	0x65735546: "fuse",
	0x6969: "nfs",
	0xff534d42: "cifs",
	0xfe534d42: "smb2",
	0x01021997: "9p",
	0x00c36400: "ceph",
	0x4d44: "vfat",
	0x5346544e: "ntfs",
	0x2011bab0: "exfat",
	0xf2f52010: "f2fs",
};

function fsTypeName(type: number): string {
	if (process.platform !== "linux") {
		return "unknown";
	}

	return fsTypes[type] ?? `0x${type.toString(16)}`;
}

function logsDisk(): ServerDiagnostics["logsDisk"] {
	try {
		const stats = fs.statfsSync(Config.getUserLogsPath());

		return {
			fsType: fsTypeName(stats.type),
			freeBytes: stats.bavail * stats.bsize,
			totalBytes: stats.blocks * stats.bsize,
		};
	} catch {
		return undefined;
	}
}

function readNumber(file: string): number | null {
	try {
		const value = fs.readFileSync(file, "utf8").trim();
		const n = Number(value);
		// "max" (v2) or a huge number (v1) mean no limit
		return Number.isFinite(n) && n < 2 ** 60 ? n : null;
	} catch {
		return null;
	}
}

// cgroup v2, then v1. Docker and Kubernetes limits show up here, not in os.totalmem().
export function cgroupLimits(root = "/sys/fs/cgroup"): ServerDiagnostics["cgroup"] {
	if (process.platform !== "linux") {
		return undefined;
	}

	let cpus: number | null = null;

	try {
		const [quota, period] = fs.readFileSync(`${root}/cpu.max`, "utf8").trim().split(" ");

		if (quota !== "max") {
			cpus = Number(quota) / Number(period);
		}
	} catch {
		const quota = readNumber(`${root}/cpu/cpu.cfs_quota_us`);
		const period = readNumber(`${root}/cpu/cpu.cfs_period_us`);

		if (quota !== null && quota > 0 && period) {
			cpus = quota / period;
		}
	}

	return {
		memoryLimitBytes:
			readNumber(`${root}/memory.max`) ?? readNumber(`${root}/memory/memory.limit_in_bytes`),
		memoryUsedBytes:
			readNumber(`${root}/memory.current`) ??
			readNumber(`${root}/memory/memory.usage_in_bytes`),
		cpus,
	};
}

function inContainer(): boolean {
	return fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");
}

const ms = (ns: number) => (Number.isFinite(ns) ? ns / 1e6 : 0);

export function serverDiagnostics(): ServerDiagnostics {
	const memory = process.memoryUsage();
	const loop = {
		p50Ms: ms(loopDelay.percentile(50)),
		p99Ms: ms(loopDelay.percentile(99)),
		maxMs: ms(loopDelay.max),
	};
	loopDelay.reset();

	return {
		version: Helper.getVersionNumber(),
		gitCommit: Helper.getGitCommit(),
		node: process.version,
		platform: process.platform,
		osRelease: os.release(),
		arch: process.arch,
		cpus: os.cpus().length,
		memTotalBytes: os.totalmem(),
		memFreeBytes: os.freemem(),
		uptimeS: Math.round(process.uptime()),
		container: inContainer(),
		rssBytes: memory.rss,
		heapUsedBytes: memory.heapUsed,
		eventLoop: loop,
		config: {
			messageStorage: [...Config.values.messageStorage],
			maxHistory: Config.values.maxHistory,
			prefetch: Config.values.prefetch,
			storagePolicy: Config.values.storagePolicy?.enabled
				? `${Config.values.storagePolicy.maxAgeDays}d ${Config.values.storagePolicy.deletionPolicy}`
				: "off",
		},
		logsDisk: logsDisk(),
		cgroup: cgroupLimits(),
	};
}

export function userDiagnostics(client: Client): UserDiagnostics {
	return {
		networks: client.networks.length,
		connectedNetworks: client.networks.filter((n) => n.irc?.connection?.connected).length,
		// Lobbies are counted as networks, not channels
		channels: client.networks.reduce((sum, n) => sum + n.channels.length - 1, 0),
	};
}

const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Two or more groups with a "::", or eight full groups
const ipv6 = /\b(?:[0-9a-f]{1,4}:){1,7}:?[0-9a-f]{0,4}(?::[0-9a-f]{1,4})*\b/gi;

/**
 * Takes paths, addresses and the user's name out of a message, such as an
 * error, before it goes into a diagnostics report.
 */
export function scrub(text: string, userName?: string): string {
	let result = text;

	const paths: [string, string][] = [
		[Config.getUserLogsPath(), "<logs>"],
		[Config.getHomePath(), "<home>"],
		[os.homedir(), "~"],
	];

	for (const [path, placeholder] of paths) {
		if (path && path.length > 1) {
			result = result.split(path).join(placeholder);
		}
	}

	result = result.replace(ipv4, "<ip>").replace(ipv6, (match) =>
		// Times like 12:30:45 look like addresses, leave short ones alone
		match.includes("::") || match.split(":").length >= 4 ? "<ip>" : match
	);

	if (userName && userName.length >= 3) {
		result = result.split(userName).join("<user>");
	}

	return result;
}
