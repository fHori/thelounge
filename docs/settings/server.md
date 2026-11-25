# Server configuration (`config.js`)

Server-wide settings live in `${THELOUNGE_HOME}/config.js` (created automatically on first start). Edit the file and restart Horizon Lounge to apply changes.

## Server & reverse proxy

| Key            | Default                    | What it does                                                                                                                                             |
| -------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public`       | `false`                    | `false` requires user accounts and keeps IRC connections and scrollback alive between visits. `true` disables login and discards sessions on disconnect. |
| `host`         | `undefined`                | Listen address (`"127.0.0.1"` for local-only, `"unix:/path/to/app.sock"` for a UNIX socket, or `undefined` for all interfaces).                          |
| `port`         | `9000`                     | Port for the web UI and WebSocket server.                                                                                                                |
| `bind`         | `undefined`                | Outgoing local IP address for IRC connections.                                                                                                           |
| `reverseProxy` | `false`                    | Set to `true` behind nginx/Caddy/Traefik so `X-Forwarded-For` is honored.                                                                                |
| `transports`   | `["polling", "websocket"]` | Socket.IO transports exposed to clients.                                                                                                                 |
| `https`        | `{ enable: false, ... }`   | Built-in TLS termination (`enable`, `key`, `certificate`, `ca`). Prefer a reverse proxy in production.                                                   |

## Message storage & retention

| Key                            | Default              | What it does                                                                                                                             |
| ------------------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `maxHistory`                   | `10000`              | Maximum lines kept in memory per channel (`-1` keeps unlimited lines in memory).                                                         |
| `messageStorage`               | `["sqlite", "text"]` | Storage backends (`sqlite` for persistent history and FTS search, `text` for flat logs, or `[]` to disable).                             |
| `storagePolicy.enabled`        | `false`              | Enable periodic cleanup of old SQLite records.                                                                                           |
| `storagePolicy.maxAgeDays`     | `7`                  | Age in days before eligible messages are pruned.                                                                                         |
| `storagePolicy.deletionPolicy` | `"statusOnly"`       | `"statusOnly"` deletes joins/parts/quits/modes while keeping chat messages; `"everything"` deletes all messages older than `maxAgeDays`. |

```js
storagePolicy: {
	enabled: true,
	maxAgeDays: 30,
	deletionPolicy: "statusOnly",
}
```

## Link previews

| Key                     | Default | What it does                                                                                         |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `prefetch`              | `false` | Fetch titles, descriptions, and thumbnails for URLs shared in chat.                                  |
| `disableMediaPreview`   | `false` | Block direct browser requests to third-party image/video hosts unless proxied via `prefetchStorage`. |
| `prefetchStorage`       | `false` | Proxy and cache fetched images under `${THELOUNGE_HOME}/storage`.                                    |
| `prefetchMaxImageSize`  | `2048`  | Maximum image size in KB (`2048` = 2 MB).                                                            |
| `prefetchMaxSearchSize` | `50`    | Maximum HTML head response size in KB when reading Open Graph tags.                                  |
| `prefetchTimeout`       | `5000`  | Timeout in milliseconds for outbound preview fetches.                                                |

## Netsplit collapsing (`massEventDetection`)

`massEventDetection` buffers rapid join, part, quit, or mode floods and collapses them into a single summary line in chat while still writing individual events to storage.

| Key                 | Default  | What it does                                                              |
| ------------------- | -------- | ------------------------------------------------------------------------- |
| `enable`            | `true`   | Turn mass-event aggregation on or off.                                    |
| `threshold`         | `10`     | Number of status events within `windowMs` needed to enter collapsed mode. |
| `windowMs`          | `10000`  | Sliding window in milliseconds (`10s`).                                   |
| `cooldownMs`        | `10000`  | Quiet period in milliseconds before leaving collapsed mode.               |
| `maxDurationMs`     | `300000` | Maximum length of a single collapsed burst (`5m`).                        |
| `refreshNamesAfter` | `true`   | Send `NAMES` once the burst settles so the user list stays accurate.      |

## Other server defaults

- **`theme`**: Default theme package name for new users (e.g. `"default"`, `"morning"`, or an installed theme package).
- **`defaults`**: Default network fields prefilled in the **Connect** window (`name`, `host`, `port`, `password`, `tls`, `rejectUnauthorized`, `nick`, `username`, `realname`, `join`, `leaveMessage`).
- **`lockNetwork`**: Set to `true` to lock users to the server's `defaults` network.
- **`leaveMessage`**: Default quit/part message when a user doesn't provide one.
- **`useHexIp`**: Encode client IPv4 addresses as hex in the IRC `username` field.

See also [File uploads](/settings/uploads) for `fileUpload` options and [Trackers & shoutbox](/settings/trackers) for `trackers`.
