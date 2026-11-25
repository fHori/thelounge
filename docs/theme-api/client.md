# Client API v1

::: warning Open draft — not yet implemented
The Theme Module API is an open design draft and is not yet implemented in Horizon Lounge. Interfaces, capabilities, and slot names may change before v1 ships.
:::

A theme package can ship a browser ES module (`"client": "dist/client.mjs"`) and optional companion styles (`"clientCss"`). Core loads the module only while that theme is active, and unloads all registrations cleanly when the user switches away.

::: tip Safe mode
Appending `?nomodules` to the Horizon Lounge URL skips all client modules while keeping theme CSS active.
:::

## Entry contract

```ts
// dist/client.mjs
export const apiVersion = "^1.0.0"; // optional pre-check

export function activate(api: ModuleClientAPI): void | Promise<void> {
  // Register slots, hooks, settings, and RPC listeners
}

export function deactivate(): void {
  // Optional cleanup (registered disposables are cleaned up automatically)
}
```

Because browsers cache ES modules by URL, `activate` must be idempotent and keep all mutable state inside its closure so switching away and back works cleanly.

## `api` surface

```ts
interface ModuleClientAPI {
  readonly version: string; // e.g. "1.0.0"
  readonly package: {name: string; version: string};
  has(feature: string): boolean; // e.g. "slot:message.avatar", "hook:message.groupWith"
  readonly vue: typeof import("vue"); // shared runtime Vue instance
  slots: SlotRegistry;
  hooks: HookRegistry;
  store: ReadonlyStoreAccess;
  rpc?: ClientRpc; // present when "rpc" capability declared
  storage?: ClientStorage; // present when "storage" capability declared
  assets?: ClientAssets; // present when "assets" capability declared
  settings: ModuleSettings;
  css: ModuleCss;
  ui: {
    contextMenu(event: MouseEvent, items: ModuleMenuItem[]): void;
    notify(text: string): void;
  };
  log: {error; warn; info; debug};
  onDeactivate(fn: () => void): void;
}
```

Core runs the runtime-only build of Vue (no runtime template compiler under CSP), so client modules author render functions via `api.vue` (`h`, `defineComponent`, `ref`, `computed`) or precompile `.vue` SFCs against `thelounge-module-types/vue-shim`.

## Slots

Slots inject Vue components into core UI points without replacing entire components. Every slot site is guarded reactively (`v-if`), creating zero component instances when no module registers that slot.

| Slot                   | Location                                 | Key props                                           |
| ---------------------- | ---------------------------------------- | --------------------------------------------------- |
| `message.avatar`       | Before message timestamp                 | `message`, `network`, `channel`, `isPreviousSource` |
| `message.header`       | Above message body                       | `message`, `network`, `channel`, `isPreviousSource` |
| `message.actions`      | Inside message hover actions             | `message`, `network`, `channel`                     |
| `userlist.groupHeader` | Start of each user-list group            | `groupKey`, `label`, `count`, `channel`             |
| `userlist.userPrefix`  | Before each nick in user list            | `user`, `channel`                                   |
| `network.icon`         | Beside network name in sidebar           | `network`                                           |
| `sidebar.rail`         | Vertical rail at left of sidebar         | `networks`, `activeNetwork`                         |
| `chat.headerActions`   | Before mentions button in chat header    | `network`, `channel`                                |
| `app.overlay`          | Top-level mount point for popovers/cards | `{}`                                                |
| `settings.appearance`  | Under Theme picker in Appearance         | `{}`                                                |

All slot props are read-only proxies.

## Hooks

Hooks let a module customize specific core decisions synchronously:

| Hook                | Purpose                                                            | Return contract                                     |
| ------------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| `message.groupWith` | Override consecutive message grouping (e.g. 7-minute window)       | `boolean` to force, or `undefined` for core default |
| `nick.click`        | Intercept left-click on a username (right-click always opens menu) | Return `true` to suppress default menu              |
| `contextMenu.user`  | Append actions to the user context menu                            | `ModuleMenuItem[]` (`label`, `class`, `action`)     |
| `userlist.group`    | Customize member-list grouping when not searching                  | Array of `{ key, label, users }` or `undefined`     |
| `message.classes`   | Add prefixed CSS classes to message rows                           | `string[]` (must use module prefix)                 |

## Store, RPC, settings & CSS

- **Read-only store (`api.store`)**: Exposes read-only reactive state (`networks`, `activeChannel`, `isConnected`, `serverConfiguration`, `settings`), helpers (`findNetwork`, `findChannel`, `watch`), and `openChannel(id)` for navigation.
- **Client RPC & storage (`api.rpc`, `api.storage`, `api.assets`)**: Scoped automatically to the module's package. `api.rpc` rejects immediately with `code: "offline"` when disconnected; `api.storage` syncs per-user keys across tabs via `$storage.*` RPC.
- **Settings (`api.settings`)**: Register `boolean`, `select`, or `text` options stored under `m:<pkg>:<key>` that render automatically under **Settings → Appearance** and sync across devices.
- **CSS helpers (`api.css`)**: Toggle package-prefixed body classes (`setBodyClass`) and `:root` custom properties (`setRootVar`), automatically reverted on deactivation.

## Error isolation & performance

- Each slot component renders inside its own Vue error boundary (`onErrorCaptured`); `3` render errors disable that slot registration for the session.
- Hook exceptions fall back to core defaults and disable the hook after `5` errors.
- Reaching `20` module errors in `60s` deactivates the module and offers a **Disable theme module** toggle.
- Target budgets: keep client bundles under `150 KiB` gzipped, `activate()` under `50 ms`, and `message.groupWith` under `5 µs` per call.
