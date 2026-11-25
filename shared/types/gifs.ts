// GIF picker (see server/plugins/gifs.ts)

export type GifProvider = "giphy" | "tenor";

export type Gifs = {
	enable: boolean;
	provider: GifProvider;
	giphyKey: string;
	tenorKey: string;
	// Giphy: g, pg, pg-13, r. Tenor: mapped to its content filter.
	rating: string;
};

export type GifMedia = {url: string; width: number; height: number; mp4?: string};

export type Gif = {
	id: string;
	title: string;
	preview: GifMedia; // small, for the picker
	url: string; // what gets sent
};

export type GifPage = {items: Gif[]; next: string | null};
