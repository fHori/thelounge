# What's different

Highlights and additions included in Horizon Lounge.

## Search & message history

- **Full-history FTS search**: Search across your entire SQLite message history instead of only recently loaded buffers, and jump straight to any search hit or mention.
- **Unlimited scrollback & fast loads**: Long channel histories load incrementally without freezing the browser or server.
- **Dedicated SQLite worker**: Database reads and writes run on a separate thread so slow disks do not stall IRC traffic or UI updates.
- **`storagePolicy`**: Optional background cleanup for old SQLite entries (`statusOnly` or `everything` older than `maxAgeDays`).

## Trackers & IRC quality of life

- **Tracker profiles**: Right-click a nick on a configured network to open their profile on the tracker website (`{nick}` or `{ident}` resolution). Configure custom entries or overrides under `trackers` in `config.js`.
- **Shoutbox bridge matchers**: Messages relayed by tracker shoutbox bots are rewritten to show the real sender and link to their tracker profile.
- **Collapsible netsplits (`massEventDetection`)**: Rapid join/part/quit storms collapse into a single summary line in the UI while preserving full events in storage. Defaults to `10` status messages in `10s`, cooling down after `10s`, and refreshing `NAMES` afterward.
- **Direct messages sidebar**: Private messages appear in their own sidebar section with channel/DM pinning.
- **Read marker sync (`draft/read-marker`)**: On servers and bouncers that support it (soju, Ergo), opening a channel marks it read on your other IRC clients, and reading it elsewhere clears the unread badge here. A channel left open in a background tab does not count as read. Needs `server-time`, which those servers offer.
- **Replies & commands**: Reply directly to messages, and use `/rainbow` and `/cleartopic`.

## File uploads & security

- **Authenticated uploads**: Upload endpoints require a logged-in session.
- **Multiple backends**: Upload to Catbox, Zipline, rustypaste, and other configured providers, or host locally under `${THELOUNGE_HOME}/uploads`.
- **Local auto-expiry**: Users can opt into `1-7` day automatic expiration for local uploads; an hourly sweep removes expired files.
- **Input & container hardening**: Malformed IRC or client payloads cannot crash the server, and the Docker image supports locked-down `user: "1000:1000"` + `read_only: true` + `cap_drop: [ALL]` setups.

## Theme Module API (Open Draft)

An upcoming module API (currently an open, unimplemented draft) will let themes ship scoped client/server modules, declarative settings, RPC endpoints, and tracker profile integrations. See the [Theme Module API](/theme-api/) draft specification.
