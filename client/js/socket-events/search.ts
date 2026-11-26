import socket from "../socket";
import {store} from "../store";

socket.on("search:results", (chunk) => {
	const search = store.state.messageSearch;

	// From a search that was replaced by another, or left
	if (!search || search.id !== chunk.id || search.done) {
		return;
	}

	if (chunk.results.length) {
		store.commit("addMessageSearchResults", chunk.results);
	}

	if (chunk.done) {
		store.commit("messageSearch", {...search, done: true, cursor: chunk.cursor});
	}
});
