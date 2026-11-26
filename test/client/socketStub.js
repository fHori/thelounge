"use strict";

// Stands in for client/js/socket in the client test bundle: modules that
// register socket handlers at load time get no-ops instead of a connection
const socket = {connected: false};

for (const method of ["on", "once", "off", "emit", "open", "connect", "disconnect"]) {
	socket[method] = () => socket;
}

module.exports = socket;
