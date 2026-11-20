import {expect} from "vitest";
import sinon from "sinon";

import log from "../../server/log.js";
import Config, {type ConfigType} from "../../server/config.js";
import TestUtil from "../util.js";

// Test-specific type for config merge testing (arbitrary nested config objects)
type TestConfigValue = string | number | boolean | null | (() => unknown) | string[] | TestConfig;
interface TestConfig {
	[key: string]: TestConfigValue | TestConfig;
}

// The merge is generic; the tests use small ad hoc objects, not full configs
const merge = (oldConfig: TestConfig, newConfig: TestConfig) =>
	Config._merge_config_objects(
		oldConfig as unknown as ConfigType,
		newConfig as unknown as ConfigType
	);

describe("mergeConfig", function () {
	let sandbox: sinon.SinonSandbox;

	beforeEach(function () {
		sandbox = sinon.createSandbox();
	});

	afterEach(function () {
		sandbox.restore();
	});

	it("should mutate object", function () {
		const config = {
			ip: "default",
		} as TestConfig;

		expect(
			merge(config, {
				ip: "overridden",
			})
		).to.deep.equal({
			ip: "overridden",
		});

		expect(config).to.deep.equal({
			ip: "overridden",
		});
	});

	it("should merge new properties", function () {
		expect(
			merge(
				{
					ip: "default",
					newProp: "this should appear too",
				},
				{
					ip: "overridden",
				}
			)
		).to.deep.equal({
			ip: "overridden",
			newProp: "this should appear too",
		});
	});

	it("should extend objects", function () {
		expect(
			merge(
				{
					tlsOptions: {},
				},
				{
					tlsOptions: {
						user: "test",
						thing: 123,
					},
				}
			)
		).to.deep.equal({
			tlsOptions: {
				user: "test",
				thing: 123,
			},
		});
	});

	it("should warn for unknown top level keys", function () {
		let warning = "";
		sandbox.stub(log, "warn").callsFake(TestUtil.sanitizeLog((str) => (warning += str)));

		expect(
			merge(
				{
					optionOne: 123,
				},
				{
					optionOne: 456,
					optionTwo: 789,
				}
			)
		).to.deep.equal({
			optionOne: 456,
			optionTwo: 789,
		});

		expect(warning).to.equal('Unknown key "optionTwo", please verify your config.\n');
	});

	it("should not warn for unknown second level keys", function () {
		expect(
			merge(
				{
					optionOne: {
						subOne: 123,
					},
				},
				{
					optionOne: {
						subOne: 123,
						subTwo: 123,
					},
				}
			)
		).to.deep.equal({
			optionOne: {
				subOne: 123,
				subTwo: 123,
			},
		});
	});

	it("should allow changing nulls", function () {
		expect(
			merge(
				{
					oidentd: null,
				},
				{
					oidentd: "some path",
				}
			)
		).to.deep.equal({
			oidentd: "some path",
		});
	});

	it("should allow changing nulls with objects", function () {
		expect(
			merge(
				{
					webirc: null,
				},
				{
					webirc: {
						serverone: "password",
						servertwo: "password2",
					},
				}
			)
		).to.deep.equal({
			webirc: {
				serverone: "password",
				servertwo: "password2",
			},
		});
	});

	it("should allow changing nulls with objects that has function", function () {
		const callbackFunction = () => ({});

		expect(
			merge(
				{
					webirc: null,
				},
				{
					webirc: {
						servercb: callbackFunction,
					},
				}
			)
		).to.deep.equal({
			webirc: {
				servercb: callbackFunction,
			},
		});
	});

	it("should keep new properties inside of objects", function () {
		expect(
			merge(
				{
					nestedOnce: {
						ip: "default",
					},
					nestedTwice: {
						thing: "default",
						nested: {
							otherThing: "also default",
							newThing: "but also this",
						},
					},
				},
				{
					nestedOnce: {},
					nestedTwice: {
						nested: {
							otherThing: "overridden",
						},
					},
				}
			)
		).to.deep.equal({
			nestedOnce: {
				ip: "default",
			},
			nestedTwice: {
				thing: "default",
				nested: {
					otherThing: "overridden",
					newThing: "but also this",
				},
			},
		});
	});

	it("should not merge arrays", function () {
		expect(
			merge(
				{
					test: ["sqlite", "text"],
				},
				{
					test: ["sqlite"],
				}
			)
		).to.deep.equal({
			test: ["sqlite"],
		});

		expect(
			merge(
				{
					test: ["sqlite", "text"],
				},
				{
					test: [],
				}
			)
		).to.deep.equal({
			test: [],
		});
	});

	it("should change order in arrays", function () {
		expect(
			merge(
				{
					test: ["sqlite", "text"],
				},
				{
					test: ["text", "sqlite"],
				}
			)
		).to.deep.equal({
			test: ["text", "sqlite"],
		});
	});

	it("normalizes the default host to lowercase at load", function () {
		// The fixture (test/fixtures/.thelounge/config.js) intentionally sets a
		// mixed-case defaults.host; setHome() (run via test/fixtures/env.ts)
		// should have normalized it to lowercase.
		expect(Config.values.defaults.host).to.equal("irc.example.com");
	});

	it("should only merge same type", function () {
		sandbox.stub(log, "warn");

		expect(
			merge(
				{
					shouldBeObject: {
						thing: "yes",
					},
				},
				{
					shouldBeObject: "bad type",
				}
			)
		).to.deep.equal({
			shouldBeObject: {
				thing: "yes",
			},
		});

		expect(
			merge(
				{
					shouldBeString: "string",
				},
				{
					shouldBeString: 1234567,
				}
			)
		).to.deep.equal({
			shouldBeString: "string",
		});
	});
});
