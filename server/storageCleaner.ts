import Config from "./config.js";
import {DeletionRequest, MessageProvider} from "./plugins/messageStorage/types.js";
import log from "./log.js";
import {MessageType} from "../shared/types/msg.js";

const status_types = [
	MessageType.AWAY,
	MessageType.BACK,
	MessageType.INVITE,
	MessageType.JOIN,
	MessageType.KICK,
	MessageType.MODE,
	MessageType.MODE_CHANNEL,
	MessageType.MODE_USER,
	MessageType.NICK,
	MessageType.PART,
	MessageType.QUIT,
	MessageType.CTCP, // not technically a status, but generally those are only of interest temporarily
	MessageType.CTCP_REQUEST,
	MessageType.CHGHOST,
	MessageType.TOPIC,
	MessageType.TOPIC_SET_BY,
];

// How long one pass may keep the database busy. Passes are sized to fit it,
// so that a big backlog goes in many short passes rather than a few long ones.
const passMs = 20;
// The break between passes while a backlog is left, for other queries
const backlogPauseMs = 50;
// The wait once everything old enough is gone
const idlePauseMs = 5 * 60 * 1000;
const minLimit = 100;
const maxLimit = 20000;

export class StorageCleaner {
	db: Pick<MessageProvider, "isEnabled" | "deleteMessages">;
	olderThanDays: number;
	messageTypes: MessageType[] | null;
	limit: number;
	ticker?: ReturnType<typeof setTimeout>;
	errCount: number;
	isStopped: boolean;

	constructor(db: Pick<MessageProvider, "isEnabled" | "deleteMessages">) {
		this.errCount = 0;
		this.isStopped = true;
		this.db = db;
		this.limit = 200; // rows per pass, adjusted to passMs
		const policy = Config.values.storagePolicy;
		this.olderThanDays = policy.maxAgeDays;

		switch (policy.deletionPolicy) {
			case "statusOnly":
				this.messageTypes = status_types;
				break;
			case "everything":
				this.messageTypes = null;
				break;
			default:
				// exhaustive switch guard, blows up when user specifies a invalid policy enum
				this.messageTypes = assertNoBadPolicy();
		}
	}

	private genDeletionRequest(): DeletionRequest {
		return {
			limit: this.limit,
			messageTypes: this.messageTypes,
			olderThanDays: this.olderThanDays,
		};
	}

	async runDeletesNoLimit(): Promise<number> {
		if (!Config.values.storagePolicy.enabled) {
			// this is meant to be used by cli tools, so we guard against this
			throw new Error("storage policy is disabled");
		}

		const req = this.genDeletionRequest();
		req.limit = -1; // unlimited
		const num_deleted = await this.db.deleteMessages(req);
		return num_deleted;
	}

	private async runDeletes() {
		if (this.isStopped) {
			return;
		}

		if (!this.db.isEnabled) {
			// TODO: remove this once the server is intelligent enough to wait for init
			this.schedule(30 * 1000);
			return;
		}

		const req = this.genDeletionRequest();

		let num_deleted = 0;

		try {
			const started = Date.now();
			num_deleted = await this.db.deleteMessages(req);
			this.errCount = 0; // reset when it works
			this.adjustLimit(Date.now() - started);
		} catch (err: unknown) {
			this.errCount++;
			log.error("can't clean messages", err instanceof Error ? err.message : String(err));

			if (this.errCount === 2) {
				log.error("Cleaning failed too many times, will not retry");
				this.stop();
				return;
			}
		}

		// need to recheck here as the field may have changed since the await
		if (this.isStopped) {
			return;
		}

		if (num_deleted < req.limit) {
			this.schedule(idlePauseMs);
		} else {
			this.schedule(backlogPauseMs); // give others a chance to execute queries
		}
	}

	// Aims the next pass at passMs, growing at most twofold at a time
	private adjustLimit(took: number) {
		this.limit = Math.min(
			this.limit * 2,
			maxLimit,
			Math.max(minLimit, Math.round((this.limit * passMs) / Math.max(1, took)))
		);
	}

	private schedule(ms: number) {
		this.ticker = setTimeout(() => {
			this.runDeletes().catch((err) => {
				log.error("storageCleaner: unexpected failure");
				throw err;
			});
		}, ms);
	}

	start() {
		this.isStopped = false;
		this.schedule(0);
	}

	stop() {
		this.isStopped = true;

		if (!this.ticker) {
			return;
		}

		clearTimeout(this.ticker);
	}
}

function assertNoBadPolicy(): never {
	throw new Error(
		`Invalid deletion policy "${Config.values.storagePolicy.deletionPolicy}" in the \`storagePolicy\` object, fix your config.`
	);
}
