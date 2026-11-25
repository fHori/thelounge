# Versioning & Security

::: warning Open draft — not yet implemented
The Theme Module API is an open design draft and is not yet implemented in Horizon Lounge. Interfaces, capabilities, and slot names may change before v1 ships.
:::

## Versioning & stability

### Separate API semver

The Module API uses its own semver (`MODULE_API_VERSION`, starting at `1.0.0`), independent of Horizon Lounge's `YEAR.FEATURE.PATCH` release version.

- Packages declare compatibility in `thelounge.api` (for example `"^1.0.0"`).
- Core checks the range at install time and on server load.
- Modules can feature-detect minor additions at runtime via `api.has("slot:...")`, `api.has("hook:...")`, or `ctx.has("...")`.

### What is covered

| Covered by v1 stability                           | Not covered (best effort)               |
| ------------------------------------------------- | --------------------------------------- |
| Signatures & behavior in `thelounge-module-types` | Core DOM structure & element hierarchy  |
| Manifest keys & capability names                  | Core CSS class names & variables        |
| Slot names, hook names, and documented props      | Exact visual placement or render timing |
| Minimum storage/asset quotas & RPC semantics      | Core internals imported outside the API |

### Breaking vs. non-breaking changes

- **Major (`2.0.0`)**: Removing or renaming slots/hooks/methods/fields, incompatible prop/return type changes, lowering documented limits, or changing hook precedence.
- **Minor (`1.x.0`)**: Adding new slots, hooks, events, capabilities, optional props, or raising limits. Deprecations include console warnings and stay supported for at least 6 months / the rest of the major version.
- **Patch (`1.0.x`)**: Bug fixes, performance improvements, and documentation updates.

## Security & trust model

### Admin-installed trust

Only server administrators can install packages (`thelounge install` or filesystem access). Server code runs inside the Node.js process with normal plugin privileges, and client modules run in the browser page origin.

Capabilities (`storage`, `assets`, `fetch`, `rpc`, `events`, `irc.whois`) are **least-privilege guardrails by default** — they prevent accidental access and make capability changes visible on install/upgrade, rather than sandboxing malicious code.

### Core-enforced isolation

Through the official APIs, core enforces:

- **Per-user partitioning**: `ModuleUser` handles come only from authenticated RPC calls and server events. Storage and assets are isolated by `(package, user)`.
- **Credential redaction**: `NetworkSummary` omits passwords, SASL secrets, proxy credentials, and raw `commands`.
- **Single-use bound upload tokens**: Asset upload tokens are bound to `(user, package, network, tag)`.
- **SSRF protection on `fetch`**: Blocks private/loopback/link-local ranges, pins DNS lookups, and rejects unsafe redirects.
- **Zero CSP relaxation**: Modules load from `'self'` without `unsafe-eval`, `blob:`, or inline script allowances.
