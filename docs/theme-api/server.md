# Server API v1

::: warning Open draft — not yet implemented
The Theme Module API is an open design draft and is not yet implemented in Horizon Lounge. Interfaces, capabilities, and slot names may change before v1 ships.
:::

Packages opt into the server module API by exporting `activate(ctx)` (and an optional `deactivate()` hook for graceful shutdown):

```ts
export function activate(ctx: ModuleServerContext): void | Promise<void> {
  // Register RPC methods, event listeners, etc.
}

export function deactivate(): void | Promise<void> {
  // Optional cleanup on shutdown
}
```

## Context & capabilities

`ctx` only exposes namespaces whose capability was declared in `package.json`:

```ts
interface ModuleServerContext {
  readonly apiVersion: string; // e.g. "1.0.0"
  readonly package: {name: string; version: string; dataDir: string};
  has(capability: Capability | `feature:${string}`): boolean;
  log: {error; warn; info; debug};
  config: {
    get<T>(key: string, fallback: T): T; // reads packageConfig[pkg][key] only
  };
  onDispose(fn: () => void | Promise<void>): void;

  storage?: ModuleStorage;
  assets?: ModuleAssets;
  fetch?: ModuleFetch;
  rpc?: ModuleRpc;
  events?: ModuleEvents;
  irc?: {whois(user: ModuleUser, network: string, nick: string): Promise<ModuleWhois>};
}
```

| Capability  | Purpose                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `storage`   | Package-scoped global and per-user JSON key/value stores.                                  |
| `assets`    | Per-user uploaded or server-stored images (PNG, JPEG, GIF, WebP, AVIF, ICO; SVG rejected). |
| `fetch`     | SSRF-safe outbound HTTP(S) requests with DNS pinning and caching.                          |
| `rpc`       | Typed Socket.IO RPC methods and per-user server-to-client push events.                     |
| `events`    | Read-only lifecycle events (user, network, channel, member, and WHOIS).                    |
| `irc.whois` | Silent WHOIS queries without opening a query tab or printing to chat.                      |

### `ModuleUser` handles

Server APIs never pass raw `Client` objects. Instead, RPC calls and events pass an opaque `ModuleUser` handle exposing `name` and sanitized `networks()` summaries (`uuid`, `name`, `host`, `nick`, `connected` — never passwords, SASL, or proxy credentials).

## `storage`

Synchronous in-memory JSON key/value store backed by debounced atomic writes (`structuredClone` on read):

```ts
interface ModuleStorage {
  global: KV; // persisted in <packagesPath>/<pkg>/module-data/global.json
  user(user: ModuleUser): KV; // persisted in users/<name>.json under packages[pkg]
}
```

- **Minimum guaranteed quotas**: `256 KiB` serialized global per package; `64 KiB` serialized per user per package.
- **Automatic cleanup**: Per-user package data is deleted automatically when a user account is removed; `thelounge packages prune-data <pkg>` clears global data.
- **Client bridge**: The client module accesses the same per-user store automatically via `api.storage`.

## `assets`

Stores user-scoped images (such as network icons or fetched favicons) with core-enforced quotas and cleanup:

```ts
interface ModuleAssets {
  put(user: ModuleUser, data: Buffer, opts: {network?: string; tag?: string}): Promise<AssetRef>;
  get(user: ModuleUser, id: string): AssetRef | undefined;
  list(user: ModuleUser, filter?: {network?: string; tag?: string}): AssetRef[];
  delete(user: ModuleUser, id: string): Promise<void>;
  onUploaded(fn: (user: ModuleUser, asset: AssetRef, meta: Json) => void | Promise<void>): void;
}
```

- **Limits**: `512 KiB` per image, `4 MiB` / `64` files per user per package (admin-configurable via `packageAssets` in `config.js`). Types are sniffed server-side; SVGs are rejected.
- **Serving**: Served at `GET /module-assets/:pkg/:id` using 128-bit unguessable IDs, strict CSP (`default-src 'none'; sandbox`), and `immutable` caching.
- **Cleanup**: Assets tied to a `network` UUID are deleted automatically when that network is removed, and all user assets are deleted when the user is removed.

## `fetch`

SSRF-safe outbound HTTP(S) client with `http:`/`https:` validation, private-IP `net.BlockList` checks, DNS-pinned `undici` connections, manual redirect verification (up to 3 hops), and an in-memory LRU cache (`1` hour default TTL):

```ts
const page = await ctx.fetch!(siteUrl, {as: "text", maxBytes: 256 * 1024});
const icon = await ctx.fetch!(iconUrl, {as: "image", maxBytes: 128 * 1024});
```

Admins can disable outbound fetches globally via `packageFetch.enable: false` in `config.js` or opt into private ranges with `packageFetch.allowPrivate: true`.

## `rpc`

Register package-scoped methods callable from the client module and push events back to that user's tabs:

```ts
ctx.rpc!.method(
  "networkIcon.set",
  (call, network, assetId) => {
    // Runs scoped to call.user
    ctx.rpc!.emit(call.user, "icons.changed", updated);
    return {ok: true};
  },
  {validate: v.args(v.uuid(), v.hex(32))}
);
```

- **Guardrails**: Arguments capped at `8` items / `64 KiB` JSON, per-socket rate limit (`20` burst, `10/s`), `10s` default timeout (`30s` max).
- **Error hygiene**: Only `ModuleRpcError` messages are forwarded to the browser; unexpected exceptions return `"Internal error"`.

## `events` & `irc.whois`

- **Read-only events (`ctx.events.on`)**: Observe `user:loaded`, `user:removed`, `client:attached`, `client:detached`, `network:*`, `channel:joined`/`parted`, `member:join`/`part`/`quit`/`nick`, and `whois`. Payloads are frozen plain objects. (Per-line `message` events are excluded in v1 for performance.)
- **Silent WHOIS (`ctx.irc.whois`)**: Resolves a `ModuleWhois` record (cached `60s` per user/network/nick, stripping operator-only IP fields unless opered) without opening a query window or printing to chat.
