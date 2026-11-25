import {expect} from "chai";
import {
	allowGifSearch,
	gifLimits,
	parseGiphy,
	parseTenor,
	resetGifs,
} from "../../server/plugins/gifs.js";

describe("GIF search", function () {
	beforeEach(resetGifs);

	it("reads Giphy results and paging", function () {
		const page = parseGiphy({
			data: [
				{
					id: "a",
					title: "hello",
					images: {
						fixed_width: {
							url: "https://media.giphy.com/a/200w.gif",
							width: "200",
							height: "150",
							mp4: "https://media.giphy.com/a/200w.mp4",
						},
						downsized: {url: "https://media.giphy.com/a/giphy-downsized.gif"},
						original: {url: "https://media.giphy.com/a/giphy.gif"},
					},
				},
				{id: "no-images"},
				{
					id: "http",
					images: {fixed_width: {url: "http://x/a.gif"}, original: {url: "http://x"}},
				},
			],
			pagination: {total_count: 100, count: 30, offset: 0},
		});

		expect(page.items).to.deep.equal([
			{
				id: "a",
				title: "hello",
				preview: {
					url: "https://media.giphy.com/a/200w.gif",
					width: 200,
					height: 150,
					mp4: "https://media.giphy.com/a/200w.mp4",
				},
				url: "https://media.giphy.com/a/giphy-downsized.gif",
			},
		]);
		expect(page.next).to.equal("30");
		expect(parseGiphy({data: [], pagination: {total_count: 0}}).next).to.equal(null);
	});

	it("reads Tenor v1 and v2 results", function () {
		const v1 = parseTenor({
			results: [
				{
					id: "1",
					content_description: "a wave",
					media: [
						{
							tinygif: {url: "https://media.tenor.com/t.gif", dims: [220, 124]},
							gif: {url: "https://media.tenor.com/g.gif"},
						},
					],
				},
			],
			next: "20",
		});
		expect(v1.items[0]).to.deep.include({
			id: "1",
			title: "a wave",
			url: "https://media.tenor.com/g.gif",
		});
		expect(v1.items[0].preview).to.deep.include({width: 220, height: 124});
		expect(v1.next).to.equal("20");

		const v2 = parseTenor({
			results: [
				{
					id: "2",
					media_formats: {
						tinygif: {url: "https://media.tenor.com/t2.gif", dims: [100, 80]},
						gif: {url: "https://media.tenor.com/g2.gif"},
						tinymp4: {url: "https://media.tenor.com/t2.mp4"},
					},
				},
			],
			next: "",
		});
		expect(v2.items[0].preview.mp4).to.equal("https://media.tenor.com/t2.mp4");
		expect(v2.next).to.equal(null);
	});

	it("rate limits searches per user", function () {
		const now = 1_000_000;

		for (let i = 0; i < gifLimits.searchesPerMinute; i++) {
			expect(allowGifSearch("alice", now)).to.equal(true);
		}

		expect(allowGifSearch("alice", now)).to.equal(false);
		expect(allowGifSearch("bob", now)).to.equal(true);
		expect(allowGifSearch("alice", now + 61000)).to.equal(true);
	});
});
