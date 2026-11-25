import {expect} from "chai";
import {featureEnabled, features, parseFeatureValues} from "../../shared/features.js";

describe("optional features", function () {
	it("keeps only known features with boolean values", function () {
		expect(
			parseFeatureValues('{"quickSwitcher": true, "nope": true, "discover": "yes"}')
		).to.deep.equal({quickSwitcher: true});
		expect(parseFeatureValues("{broken")).to.deep.equal({});
		expect(parseFeatureValues("")).to.deep.equal({});
		expect(parseFeatureValues({emojiPicker: false})).to.deep.equal({emojiPicker: false});
	});

	it("the user's choice wins over the theme's default, which wins over the built-in one", function () {
		expect(featureEnabled("quickSwitcher", {}, {})).to.equal(features.quickSwitcher.default);
		expect(featureEnabled("quickSwitcher", {}, {quickSwitcher: true})).to.equal(true);
		expect(
			featureEnabled("quickSwitcher", {quickSwitcher: false}, {quickSwitcher: true})
		).to.equal(false);
		expect(featureEnabled("emojiPicker", {}, {})).to.equal(true);
	});
});
