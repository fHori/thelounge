// Stand-in for the `debug` package in the client bundle (see vite.config.mts)
// and for the client socket in client tests (see vitest.config.mts).
// ES module: this package is "type": "module".
export default function () {
	return function () {};
}
