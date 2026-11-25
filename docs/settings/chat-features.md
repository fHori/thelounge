# Search, navigation & chat features

How to use Horizon Lounge's search, sidebar navigation, inline replies, and chat commands.

## Full-history search & jump to message

When `sqlite` is enabled in `messageStorage` (the default), Horizon Lounge indexes every user's messages with SQLite FTS5.

- **Instant full-history search**: Search results span your entire saved channel history rather than only the lines currently loaded in your browser buffer.
- **Jump straight to context**: Clicking a search result or mention scrolls directly to that timestamp in history, fetching surrounding context on demand even if it sits thousands of lines back.
- **First-start background indexing**: When migrating an existing database from another build of The Lounge, Horizon Lounge opens immediately and builds the FTS index in the background per user. Search stays available during indexing (falling back to linear scans until indexing finishes) and resumes cleanly across restarts.

## Sidebar & DM management

Horizon Lounge adds dedicated controls to keep busy tracker networks manageable:

- **Separate DM section**: Private messages are grouped into their own sidebar section rather than mixed into every network's channel list.
- **Filter DMs** (`filterDmsEnabled`): Quickly filter direct messages by nick right in the DM header.
- **Show all DMs** (`showAllDMs`): Toggle whether inactive DMs stay visible or collapse away.
- **Jump to** (`jumpToEnabled`): Quick-jump input in the sidebar to switch channels or DMs from the keyboard.
- **Pinning & compact mode**: Pin priority channels or DMs, enable **Compact sidebar on Desktop** (`compactSidebar`), and optionally hide unread badges on muted channels (`disableMutedUnread`).

## Inline message replies

- Hover or open the menu on a message and click **Reply** (controlled by **Enable reply to message button** in **Settings → General**).
- By default, replies preserve IRC formatting codes; enable **Use plain text quote in reply** (`replyToMessagePlainText`) to strip bold/color/italic formatting from the quoted preview.

## Custom slash commands & shortcuts

| Command / Shortcut                 | What it does                                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/rainbow <text>` or `/rgb <text>` | Sends `<text>` formatted with cycling IRC color codes.                                                                                                        |
| `Ctrl+R`                           | Applies rainbow formatting directly to the current compose draft (toggleable via **Enable rainbow messages with 'Ctrl+R' hotkey** in **Settings → General**). |
| `/cleartopic`                      | Clears the topic of the current channel (if you have channel operator permissions).                                                                           |
