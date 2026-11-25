# Examples & Planned Extensions

::: warning Open draft — not yet implemented
The Theme Module API is an open design draft and is not yet implemented in Horizon Lounge. Interfaces, capabilities, and slot names may change before v1 ships.
:::

## Worked example: Discord skin

A complete skin like `thelounge-theme-discord` can combine standard theme CSS with a small server and client module:

### 1. Nick-colored avatars (`message.avatar`)

No server capability required — derive a color index deterministically from the nick and skip grouped follow-up messages:

```ts
export function activate(api: ModuleClientAPI) {
  const {h, defineComponent} = api.vue;

  const Avatar = defineComponent({
    props: ["message", "isPreviousSource"],
    setup: (props) => () =>
      props.isPreviousSource
        ? null
        : h(
            "span",
            {
              class: `tlm-discord-avatar c${hash(props.message.from.nick) % 16}`,
              "aria-hidden": "true",
            },
            props.message.from.nick[0].toUpperCase()
          ),
  });

  api.slots.register("message.avatar", Avatar);
}
```

### 2. Cozy vs. compact grouping (`settings` + `message.groupWith`)

```ts
api.settings.register({
  key: "density",
  label: "Message display",
  type: "select",
  default: "cozy",
  options: [
    {value: "cozy", label: "Cozy"},
    {value: "compact", label: "Compact"},
  ],
  apply: (v) => api.css.setBodyClass("tlm-discord-compact", v === "compact"),
});

api.hooks.on("message.groupWith", (prev, msg) => {
  if (api.settings.get("density") === "compact") return undefined;
  return (
    prev.type === "message" &&
    msg.type === "message" &&
    prev.from?.nick === msg.from?.nick &&
    new Date(msg.time).getTime() - new Date(prev.time).getTime() < 7 * 60_000
  );
});
```

### 3. Network icons & server rail (`assets` + `fetch` + `rpc` + `sidebar.rail`)

- **Upload**: Client uploads a file via `api.assets.upload(file, { network: network.uuid, tag: 'network-icon' })` and saves it via `api.rpc.call('networkIcon.set', network.uuid, asset.id)`.
- **Favicon fallback**: On `network:added`, the server uses `ctx.fetch` to grab the network's site favicon and saves it via `ctx.assets.put`.
- **Rail**: `sidebar.rail` renders clickable network icons calling `api.store.openChannel(...)`.

### 4. WHOIS profile card (`irc.whois` + `nick.click` + `app.overlay`)

- Clicking a nick triggers `nick.click`, calls a server RPC wrapping `ctx.irc.whois(call.user, network, nick)`, and renders a floating profile popover inside `app.overlay`.

---

## Planned extensions in the draft

### Declarative theme options (no JS required)

Themes can declare simple `boolean`, `select`, `color`, and `range` options directly inside `thelounge.options` in `package.json`:

```json
"thelounge": {
  "type": "theme",
  "css": "dist/theme.css",
  "options": {
    "messageDisplay": {
      "type": "select",
      "label": "Message display",
      "default": "compact",
      "choices": { "compact": "Compact", "cozy": "Cozy" },
      "css": { "cozy": "cozy.css" }
    },
    "accent": {
      "type": "color",
      "label": "Accent colour",
      "default": "#5865f2",
      "cssVar": "--dc-brand"
    }
  }
}
```

Core renders the UI under **Settings → Appearance**, syncs selections across devices via `themeOptions`, sets `data-theme-<key>` attributes on `<html>`, updates `cssVar` custom properties, and loads per-option stylesheets automatically.

### Theme icons & package metadata

- **Theme icons**: Optional `thelounge.icons` (`favicon`, `faviconAlerted`, `touchIcon`) to swap browser favicons cleanly when a theme is active.
- **Author & source links**: Standard npm `author`, `repository`, and `homepage` fields displayed under the theme picker in **Settings → Appearance** and during CLI install.

### Tracker profile & avatar providers

Core extension planned on top of the `trackers` registry: server-side adapters fetch user avatars and profile fields lazily (on profile open or when a user speaks in an active channel), rate-limited and cached on disk under `${THELOUNGE_HOME}/cache/profiles/`, and exposed to CSS themes via `--tl-avatar: url(...)` without ever sending site API keys to browsers.
