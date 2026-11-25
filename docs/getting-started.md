# Getting started

Horizon Lounge is a self-hosted web IRC client focused on tracker tweaks, search speed, storage reliability, and expandability.

::: warning Coming from another image or version?
Back up your data directory first. On first start, Horizon Lounge upgrades your SQLite message history to add full-text and history indexes. Other versions of The Lounge cannot read an upgraded database directly afterwards (an automatic downgrade tool is in progress in [PR #11](https://github.com/fHori/thelounge/pull/11)). See [Migrating](/migrating) before switching an existing instance.
:::

## Docker

```yaml
services:
  thelounge:
    image: ghcr.io/fhori/thelounge:latest
    environment:
      - PUID=1000
      - PGID=1000
    volumes:
      - ./thelounge:/var/opt/thelounge
    ports:
      - "9000:9000"
    restart: unless-stopped
```

Create a user once the container is running:

```sh
docker compose exec thelounge thelounge add <name>
```

### Image tags

Versions follow `year.feature.fix`: for example, `2026.12.1` is the 12th feature release of 2026 with one fix on top.

| Tag         | When to use it                                                            |
| ----------- | ------------------------------------------------------------------------- |
| `latest`    | Follow every release                                                      |
| `2026.12`   | Receive fixes and security rebuilds for that release without new features |
| `2026.12.1` | Pin an exact release and upgrade on your own schedule                     |
| `edge`      | Track the newest unreleased changes from `master`                         |

For non-root hardened containers, Unraid permissions, `THELOUNGE_HOME=/config`, and CLI commands, see [Docker](/DOCKER).

## From source

Requires Node.js 22.

```sh
git clone https://github.com/fHori/thelounge.git
cd thelounge
corepack enable
yarn install
NODE_ENV=production yarn build
yarn start
```

## Configuration

Most [upstream The Lounge options](https://thelounge.chat/docs) apply as usual. Horizon Lounge additions (including `trackers`, `massEventDetection`, `storagePolicy`, `allowFileUploadBackendSelection`, and `maskFileHost`) are documented in [What's different](/features) and [`defaults/config.js`](https://github.com/fHori/thelounge/blob/master/defaults/config.js).
