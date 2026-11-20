import {describe, expect, it} from "vitest";
import shouldShowUserListStatus from "../../../../client/js/helpers/statusIndicators";

describe("shouldShowUserListStatus", function () {
	it("hides the dots when status indicators are off", function () {
		expect(shouldShowUserListStatus(false, false, true)).toBe(false);
		expect(shouldShowUserListStatus(false, true, true)).toBe(false);
	});

	it("shows the dots only on away-notify servers by default", function () {
		expect(shouldShowUserListStatus(true, true, true)).toBe(true);
		expect(shouldShowUserListStatus(true, true, false)).toBe(false);
		expect(shouldShowUserListStatus(true, true, undefined)).toBe(false);
	});

	it("shows the dots everywhere when live-only is off", function () {
		expect(shouldShowUserListStatus(true, false, false)).toBe(true);
		expect(shouldShowUserListStatus(true, false, undefined)).toBe(true);
	});
});
