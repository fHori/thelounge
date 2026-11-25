# Horizon Lounge

[![Latest release](https://img.shields.io/github/v/release/fHori/thelounge?sort=semver&display_name=tag&label=latest)](https://github.com/fHori/thelounge/releases/latest)
[![Edge build](https://img.shields.io/github/actions/workflow/status/fHori/thelounge/build.yml?branch=master&label=edge)](https://github.com/fHori/thelounge/actions/workflows/build.yml?query=branch%3Amaster)
[![Docker image](https://img.shields.io/badge/docker-ghcr.io%2Ffhori%2Fthelounge-2496ED?logo=docker&logoColor=white)](https://github.com/fHori/thelounge/pkgs/container/thelounge)
[![License](https://img.shields.io/github/license/fHori/thelounge)](LICENSE)

Fork of the popular self-hosted web IRC client with tracker focused tweaks, better performance and a focus on expandability.

**[Documentation →](https://fhori.github.io/thelounge/)**

## What's different

- Fast full-history SQLite search, and jump straight to any result or mention
- Long histories load quickly, scroll back without limit, and run SQLite on a dedicated worker thread
- Security hardening: uploads require a logged-in session, malformed IRC or browser payloads cannot crash the server, and the Docker image supports rootless `user:` setups
- Shoutbox messages relayed by tracker bots show the real sender
- Right-click a user to open their tracker profile
- Netsplits and mass reconnects collapse into one line
- Direct messages get their own sidebar section, with pinning and filtering
- Uploads to Catbox, Zipline, rustypaste and others, or local hosting with 1–7 day auto-delete
- Reply to a message, `/rainbow`, `/cleartopic`

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

Add a user with `docker compose exec thelounge thelounge add <name>`.

`latest` is the newest release. Versions read year, feature release, fix:
`2026.12.1` is the 12th feature release of 2026 with one fix on top. Pin
`2026.12` to get its fixes but no new features, pin `2026.12.1` to upgrade on
your own schedule, or use `edge` for the newest unreleased changes.
More options in [Docker](docs/DOCKER.md).

## Coming from another version

Back up your data folder first. Your message history is upgraded on first start,
and other versions of The Lounge cannot read it directly afterwards. An automatic
downgrade command is [in progress](https://github.com/fHori/thelounge/pull/11).
See the [migration guide](docs/migrating.md) for LinuxServer.io, `cmd430`, and
official image steps.

## From source

Needs Node.js 22.

```sh
git clone https://github.com/fHori/thelounge.git
cd thelounge
corepack enable
yarn install
NODE_ENV=production yarn build
yarn start
```

## Documentation & configuration

- **[Horizon Lounge docs](https://fhori.github.io/thelounge/)**: Docker, migration, server & client settings, file uploads, trackers, and chat features.
- Fork-specific `config.js` options are also documented inline in [`defaults/config.js`](defaults/config.js).

## Credits

Builds upon [The Lounge](https://github.com/thelounge/thelounge) and
[Tetrahydroc's fork](https://github.com/tetrahydroc/thelounge). See
[Credits](docs/credits.md).

## Reporting issues

Found a bug? [Open an issue](https://github.com/fHori/thelounge/issues).
For security problems, please don't open a public issue; see
[SECURITY.md](SECURITY.md).

## Development

This project leverages AI-assisted development workflows. All architecture,
logic, and code are planned, reviewed, and audited by human maintainers,
backed by automated test suites.

## License

MIT
