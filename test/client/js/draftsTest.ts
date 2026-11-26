import {expect} from "chai";
import {createDraftStore, draftKey} from "../../../client/js/drafts.js";
import {ChanType} from "../../../shared/types/chan.js";

function fakeStorage() {
	const map = new Map<string, string>();
	let writes = 0;
	return {
		map,
		get writes() {
			return writes;
		},
		get length() {
			return map.size;
		},
		key: (i: number) => [...map.keys()][i] ?? null,
		getItem: (k: string) => map.get(k) ?? null,
		setItem(k: string, v: string) {
			writes++;
			map.set(k, v);
		},
		removeItem(k: string) {
			map.delete(k);
		},
	};
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chan = (name: string, type = ChanType.CHANNEL) => ({name, type});

describe("drafts", function () {
	it("keys by network and lowercased name, lobby ignores the name", function () {
		expect(draftKey("u", chan("#Foo"))).to.equal(draftKey("u", chan("#foo")));
		expect(draftKey("u", chan("#foo"))).to.not.equal(draftKey("v", chan("#foo")));
		expect(draftKey("u", chan("Libera", ChanType.LOBBY))).to.equal(
			draftKey("u", chan("Renamed", ChanType.LOBBY))
		);
	});

	it("writes once after typing pauses", async function () {
		const storage = fakeStorage();
		const drafts = createDraftStore(() => storage, 10);

		drafts.save("u", chan("#a"), "h");
		drafts.save("u", chan("#a"), "he");
		drafts.save("u", chan("#a"), "hey");
		expect(storage.writes).to.equal(0);
		expect(drafts.load("u", chan("#a"))).to.equal("hey");

		await wait(30);
		expect(storage.writes).to.equal(1);
		expect(storage.getItem(draftKey("u", chan("#a")))).to.equal("hey");
	});

	it("removes at once when emptied, dropping a pending write", async function () {
		const storage = fakeStorage();
		const drafts = createDraftStore(() => storage, 10);
		storage.setItem(draftKey("u", chan("#a")), "old");

		drafts.save("u", chan("#a"), "new");
		drafts.save("u", chan("#a"), "");
		expect(drafts.load("u", chan("#a"))).to.equal("");

		await wait(30);
		expect(storage.map.size).to.equal(0);
	});

	it("flushes pending writes", function () {
		const storage = fakeStorage();
		const drafts = createDraftStore(() => storage, 1000);

		drafts.save("u", chan("#a"), "text");
		drafts.flush();
		expect(storage.getItem(draftKey("u", chan("#a")))).to.equal("text");
	});

	it("prunes drafts of channels that are gone, leaving other keys", function () {
		const storage = fakeStorage();
		const drafts = createDraftStore(() => storage, 1000);
		storage.setItem(draftKey("u", chan("#keep")), "1");
		storage.setItem(draftKey("u", chan("#parted")), "2");
		storage.setItem(draftKey("gone", chan("#keep")), "3");
		storage.setItem("thelounge.settings", "{}");
		drafts.save("u", chan("#pending-parted"), "4");

		drafts.prune([{uuid: "u", channels: [chan("#Keep")]}]);
		drafts.flush();

		expect([...storage.map.keys()]).to.have.members([
			draftKey("u", chan("#keep")),
			"thelounge.settings",
		]);
	});

	it("survives storage that throws", function () {
		const drafts = createDraftStore(() => {
			throw new Error("blocked");
		}, 0);

		drafts.save("u", chan("#a"), "");
		drafts.prune([]);
		expect(drafts.load("u", chan("#a"))).to.equal("");
	});
});
