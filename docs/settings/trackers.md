# Trackers & shoutbox bridges

Horizon Lounge includes built-in tracker awareness so IRC conversations and shoutbox relays connect cleanly back to tracker profiles.

## What tracker integration provides

1. **Tracker Profile context menu**: With **Use enhanced context menu** enabled (**Settings → Appearance**), right-clicking a nick on a configured tracker network offers a **Tracker Profile** link straight to their profile page on the site.
2. **Shoutbox bridge cleanup**: Messages relayed by supported tracker shoutbox bots are rewritten to show the original user's nick instead of the relay bot, and clicking that user opens their real tracker profile.

## Per-user configuration (`Settings → Trackers`)

Each user can customize trackers without touching `config.js`:

- **Override a server tracker**: Click **Change link** next to a server-defined tracker to supply your own profile URL template, or **Hide** to suppress it, or **Reset** to restore the server default.
- **Add your own tracker**: Click **Add tracker** and fill in:
  - **Name**: Display name for the tracker.
  - **Network**: Pick one of your connected IRC networks (matches server hostname).
  - **Channels**: Optional comma-separated channel list (leave empty if the whole IRC network belongs to one tracker).
  - **Profile URL**: Template using `{nick}` (for example `https://example.org/users/{nick}`) or `{ident}` when the network exposes user IDs in IRC idents.

## Server-wide configuration (`config.js`)

Horizon Lounge ships with a built-in `trackers` map in `defaults/config.js`. Anything you set in `config.js` is **merged entry by entry** with the defaults, so you only write additions, overrides, or `null` removals:

```js
trackers: {
	// Add a new tracker
	EX: {
		name: "Example",
		network: "irc.example.org",
		channels: ["#example"],
		profileUrl: "https://example.org/user/{nick}/profile",
	},
	// Override just the profile URL on a built-in entry
	SP: {
		profileUrl: "https://seedpool.org/users/{nick}",
	},
	// Disable a built-in entry
	LST: null,
},
```

To disable all tracker features server-wide, set:

```js
trackers: null,
```

### Field reference

| Field        | Required       | Description                                                                                                                           |
| ------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | Yes            | Human-readable tracker name.                                                                                                          |
| `network`    | Yes            | IRC server hostname (compared case-insensitively against your network host and IRC server name, including through bouncers like ZNC). |
| `channels`   | No             | Restrict matching to specific channels when multiple trackers share an IRC network.                                                   |
| `profileUrl` | No             | Profile URL template with `{nick}` or `{ident}`. Omit to disable profile links while still identifying the tracker.                   |
| `userHost`   | With `{ident}` | Hostmask pattern (supports `*`) such as `*@*.tracker.org` so `{ident}` lookups only run for matching users.                           |
| `disabled`   | No             | Set to `true` to ignore the entry.                                                                                                    |

::: tip How `{ident}` lookup works
On trackers whose IRC hosts use `<user id>@<name>.<class>.<tracker>`, Horizon Lounge queries the user's ident silently on click rather than caching or exposing raw metadata in chat.
:::

## Shoutbox bridge display options

Under **Settings → Appearance → Messages**:

- **Beautify supported bridged shoutbox messages** (`beautifyBridgedMessages`): Rewrites bot-relayed lines so the original author stands out cleanly.
- **Nickname style** (`bridgedMessageNicksStyle`): Display bridged authors in parentheses `(nick)` (default) or like a standard IRC nick (`nick`).
