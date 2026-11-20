import {expect} from "vitest";
import {NetworkConfig} from "../server/models/network.js";
import {ChanType} from "../shared/types/chan.js";
import ClientManager from "../server/clientManager.js";
import Client from "../server/client.js";
import log from "../server/log.js";
import Config from "../server/config.js";

import fs from "fs";
import sinon from "sinon";

describe("Client", function () {
	const commonNetworkConfig: NetworkConfig = {
		uuid: "67363f03-d903-498b-8e52-031ebb912791",
		awayMessage: "",
		name: "Super Nice Network",
		nick: "thelounge0001",
		host: "example.org",
		port: 6667,
		tls: false,
		userDisconnected: false,
		rejectUnauthorized: true,
		password: "",
		username: "thelounge",
		realname: "thelounge26",
		leaveMessage: "",
		sasl: "",
		saslAccount: "",
		saslPassword: "",
		commands: [],
		ignoreList: [],
		proxyHost: "",
		proxyPort: 1080,
		proxyUsername: "",
		proxyEnabled: false,
		proxyPassword: "",
		channels: [],
	};
	let logWarnStub: sinon.SinonStub<string[], void>;

	beforeAll(function () {
		logWarnStub = sinon.stub(log, "warn");
	});

	afterAll(function () {
		logWarnStub.restore();
	});

	it("should parse channel configuration", function () {
		const manager = new ClientManager();
		const networkConfig: NetworkConfig = {
			...commonNetworkConfig,
			channels: [{name: "AAAA!", type: "query"}, {name: "#thelounge"}, {name: "&foobar"}],
		};
		const client = new Client(manager, "test", {
			log: false,
			password: "foo",
			sessions: {},
			clientSettings: {},
			networks: [networkConfig],
		});

		// The client would normally do it as part of client.connect();
		// but this avoids the need to mock the irc-framework connection
		const network = client.networkFromConfig(networkConfig);

		sinon.assert.notCalled(logWarnStub);

		expect(network.channels[0].name).to.equal("Super Nice Network");
		expect(network.channels[0].type).to.equal(ChanType.LOBBY);
		expect(network.channels[1].name).to.equal("AAAA!");
		expect(network.channels[1].type).to.equal(ChanType.QUERY);
		expect(network.channels[2].name).to.equal("#thelounge");
		expect(network.channels[2].type).to.equal(ChanType.CHANNEL);
		expect(network.channels[3].name).to.equal("&foobar");
		expect(network.channels[3].type).to.equal(ChanType.CHANNEL);
	});

	it("should ignore invalid channel types", function () {
		const manager = new ClientManager();
		const networkConfig: NetworkConfig = {
			...commonNetworkConfig,
			channels: [
				{name: "AAAA!", type: "query"},
				{name: "#thelounge", type: "wrongtype"},
				{name: "&foobar"},
			],
		};
		const client = new Client(manager, "test", {
			log: false,
			password: "foo",
			sessions: {},
			clientSettings: {},
			networks: [networkConfig],
		});

		// The client would normally do it as part of client.connect();
		// but this avoids the need to mock the irc-framework connection
		const network = client.networkFromConfig(networkConfig);

		sinon.assert.calledOnce(logWarnStub);

		expect(network.channels[0].name).to.equal("Super Nice Network");
		expect(network.channels[0].type).to.equal(ChanType.LOBBY);
		expect(network.channels[1].name).to.equal("AAAA!");
		expect(network.channels[1].type).to.equal(ChanType.QUERY);
		expect(network.channels[2].name).to.equal("&foobar");
		expect(network.channels[2].type).to.equal(ChanType.CHANNEL);
	});

	describe("renamed settings", function () {
		let wasPublic: boolean;

		beforeEach(function () {
			// Users are only saved outside public mode
			wasPublic = Config.values.public;
			Config.values.public = false;
		});

		afterEach(function () {
			Config.values.public = wasPublic;
		});

		it("should move settings saved under their old names and write the user file", function () {
			const manager = new ClientManager();
			const writeFile = sinon.stub(fs, "writeFileSync");
			const rename = sinon.stub(fs, "renameSync");
			const client = new Client(manager, "test", {
				log: false,
				password: "foo",
				sessions: {},
				clientSettings: {jumptoEabled: false, filterdmsEnabled: false, coloredNicks: false},
				networks: [],
			});

			expect(client.config.clientSettings).to.deep.equal({
				jumpToEnabled: false,
				filterDmsEnabled: false,
				coloredNicks: false,
				searchEnabled: false,
			});

			// What happens when the user is loaded at startup: the networks are
			// set up and the hash of the loaded data is taken
			client.connect();
			client.save.flush();

			try {
				sinon.assert.calledOnce(writeFile);
				sinon.assert.calledOnce(rename);
				const written = JSON.parse(writeFile.firstCall.args[1] as string);
				expect(written.clientSettings).to.include({
					jumpToEnabled: false,
					filterDmsEnabled: false,
				});
				expect(written.clientSettings).to.not.have.property("jumptoEabled");
				expect(written.clientSettings).to.not.have.property("filterdmsEnabled");
			} finally {
				writeFile.restore();
				rename.restore();
			}
		});

		it("should not save the user when no setting was renamed", function () {
			const manager = new ClientManager();
			const saveUser = sinon.stub(manager, "saveUser");
			const client = new Client(manager, "test", {
				log: false,
				password: "foo",
				sessions: {},
				clientSettings: {jumpToEnabled: false},
				networks: [],
			});

			client.connect();
			client.save.flush();
			sinon.assert.notCalled(saveUser);
		});
	});
});
