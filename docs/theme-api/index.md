# Theme Module API

::: warning Open draft — not yet implemented
The Theme Module API is an open design draft and is not yet implemented in Horizon Lounge. Interfaces, capabilities, and slot names may change before v1 ships.
:::

Traditional themes can only ship CSS, and legacy server plugins have no versioned contract. The **Theme Module API** adds an optional, versioned module layer so packages can extend both the server and the browser client while keeping Horizon Lounge core generic.

When no module theme is selected, Horizon Lounge renders the standard UI with zero extra requests or watchers.

## Goals & non-goals

### Goals

- **Versioned contract**: Separate API semver (`^1.0.0`) independent of the Horizon Lounge app version, backed by published TypeScript types.
- **UI extensibility via slots & hooks**: Enough surface to build rich layouts (avatars, message grouping, WHOIS profile cards, server-icon rails, custom settings) without forking core components.
- **Scoped server primitives**: Per-user/global storage, per-user image assets, SSRF-safe HTTP fetch, and scoped RPC with push events.
- **Backwards compatibility**: Existing CSS themes and `onServerStart` plugins continue working unchanged.
- **Error isolation**: A failing slot, hook, or module cannot take down the client or server.

### Non-goals (v1)

- **Untrusted sandboxing**: Packages are installed by the server admin and run with normal process/page trust. Capabilities act as explicit declarations and guardrails rather than a security sandbox.
- **Arbitrary component replacement**: v1 provides named slots and hooks only.
- **Direct store or IRC mutation from the browser**: Client modules read state through read-only proxies and cannot emit raw IRC lines.
- **DOM/CSS stability guarantees**: Core DOM markup and CSS classes remain best-effort for CSS themes.

## Package manifest

A module package declares its API range, entry points, and requested capabilities inside the `"thelounge"` field of `package.json`:

```json
{
  "name": "thelounge-theme-discord",
  "version": "0.3.0",
  "thelounge": {
    "type": "theme",
    "css": "dist/theme.css",
    "api": "^1.0.0",
    "client": "dist/client.mjs",
    "clientCss": ["dist/client.css"],
    "capabilities": ["storage", "assets", "fetch", "rpc", "events", "irc.whois"],
    "publicMode": false
  }
}
```

| Field          | Type          | Notes                                                                                                  |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `api`          | semver range  | Required to enable module features (`semver.satisfies`). Checked at install and load.                  |
| `client`       | relative path | Browser ES module (`.mjs` or `.js`) loaded only when the theme is active (`type: "theme"` only in v1). |
| `clientCss`    | `string[]`    | Extra stylesheets added and removed alongside the client module.                                       |
| `capabilities` | `string[]`    | Allowed values: `storage`, `assets`, `fetch`, `rpc`, `events`, `irc.whois`. Unknown values fail load.  |
| `publicMode`   | `boolean`     | Opt in to run when `public: true`. Storage becomes memory-only; `assets` and `fetch` are disabled.     |

## Install & backwards compatibility

- During `thelounge install` (and `thelounge upgrade`), the CLI displays requested capabilities and requires confirmation (`--yes` for non-interactive setups).
- Legacy themes without `api` continue loading `/themes/<name>.css` as before.
- Legacy plugins without `api` continue calling `onServerStart(PackageAPI)` unchanged.
- Packages exporting both `onServerStart` and `activate` run `onServerStart` first, then `activate(ctx)`.
