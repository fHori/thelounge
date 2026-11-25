# Client settings

User preferences are managed inside the web UI under **Settings** and take effect immediately without restarting the server.

## Sync across devices

In private mode (`public: false`), **Settings → General → Synchronize settings with other clients** (`syncSettings`, enabled by default) stores your preferences on the server so other browsers pick them up automatically.

- **Synced settings**: highlights, highlight exceptions, away message, `notifyAllMessages`, appearance, uploads, tracker overrides, and input options.
- **Device-local settings**: browser notification permission (`desktopNotifications`) and notification sound (`notification`) always stay per-browser so you can mute a secondary device independently.

## General

| Setting                       | Default | Description                                                                                                                                   |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **File uploads**              | Local   | Strip EXIF/metadata via `<canvas>` (`uploadCanvas`), select an upload host, API URL/key, and TTL. See [File uploads](/settings/uploads).      |
| **Rainbow hotkey (`Ctrl+R`)** | On      | Toggle rainbow text formatting with `Ctrl+R` (`enableRainbowHotkey`). `/rainbow` and `/rgb` always work.                                      |
| **Reply button**              | On      | Show a reply action on messages (`enableReplyToMessage`) and optionally quote without IRC color/formatting codes (`replyToMessagePlainText`). |
| **Automatic away message**    | Empty   | Away status sent automatically when no Horizon Lounge browser sessions are open (`awayMessage`).                                              |

## Appearance

### Messages & formatting

- **Show MOTD** (`motd`): Display server Message of the Day blocks on connect.
- **Timestamps** (`showSeconds`, `use12hClock`): Include seconds and switch between 24-hour and 12-hour clocks.
- **Beautify bridged shoutbox messages** (`beautifyBridgedMessages`): Rewrite supported tracker shoutbox bot relays to display the original sender, formatted either in parentheses `(nick)` or as a normal nick (`bridgedMessageNicksStyle`).
- **Don't show unread badges on muted channels** (`disableMutedUnread`): Suppress unread indicators on muted channels.
- **Status messages** (`statusMessages`): Show joins/parts/quits/nicks individually (`shown`), grouped together (`condensed`), or hidden (`hidden`).
- **Link previews** (`media`, `links`): Auto-expand media or website cards when server `prefetch` is enabled.

### Layout & navigation

- **Use enhanced user list** (`enhancedUserListEnabled`): Enable enhanced user list features when provided by an active theme module.
- **Use enhanced context menu** (`enhancedContextMenuEnabled`): Enable extra user context menu actions such as **Tracker Profile** links.
- **Show current nick in input box** (`showInputNick`): Display your active nick beside the compose field.
- **Enable "Jump to" in sidebar** (`jumpToEnabled`): Show the quick-jump filter/search control in the sidebar.
- **DM section controls** (`filterDmsEnabled`, `showAllDMs`): Enable the DM filter bar and choose whether all DM channels stay visible in the sidebar.
- **Compact sidebar on Desktop** (`compactSidebar`): Tighten channel list spacing on desktop viewports.

### Visual aids & custom CSS

- **Colored nicknames** (`coloredNicks`) and **Autocomplete** (`autocomplete` + `nickPostfix`, e.g. `", "`).
- **Theme** (`theme`): Switch between built-in and installed themes.
- **Custom stylesheet** (`userStyles`): Inject per-user CSS overrides live. If broken CSS ever locks you out of the UI, append `?nocss` to your Horizon Lounge URL to load without user styles.

## Notifications

- **Push Notifications**: Subscribe to Web Push notifications when served over HTTPS.
- **Browser Notifications** (`desktopNotifications`) and **Notification sound** (`notification`).
- **Notify on all messages** (`notifyAllMessages`): Trigger notifications for every message, not just highlights and DMs.
- **Custom highlights** (`highlights`) & **Highlight exceptions** (`highlightExceptions`): Comma-separated match patterns and exclusion words.

## Trackers & Account

- **Trackers**: Manage personal tracker profile links and overrides. See [Trackers & shoutbox](/settings/trackers).
- **Account** (private mode): Change your password and inspect or revoke active sessions.
