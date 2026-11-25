# Migrating to Horizon Lounge

This covers moving an existing Docker setup from:

- **A. LinuxServer.io (`lscr.io/linuxserver/thelounge`) or `cmd430/docker-thelounge`** (both keep data in `/config` and use `PUID`/`PGID`)
- **B. The official image (`thelounge/thelounge`)**

All three keep your settings, users, and message history. The only differences are where the data folder lives inside the container and which user owns it.

|                          | A. LinuxServer / cmd430                                             | B. Official           | Horizon Lounge                                                    |
| ------------------------ | ------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------- |
| Image                    | `lscr.io/linuxserver/thelounge` / `ghcr.io/cmd430/docker-thelounge` | `thelounge/thelounge` | `ghcr.io/fhori/thelounge`                                         |
| Data folder in container | `/config`                                                           | `/var/opt/thelounge`  | `/var/opt/thelounge` (or `/config` with `THELOUNGE_HOME=/config`) |
| Runs as                  | `PUID`:`PGID` (default `911:911`)                                   | `1000` (`node`)       | `PUID`:`PGID` (default `1000:1000`), or `user:`                   |
| Port                     | `9000`                                                              | `9000`                | `9000`                                                            |

> **If you only change the `image:` line and start it, you may see an empty instance** if your data is in `/config` while something already exists in `/var/opt/thelounge`. Your data is not lost; set `THELOUNGE_HOME=/config` explicitly (see Scenario A below).

---

## Before you start (both scenarios)

1. **Stop the old container.**

   ```bash
   docker compose down
   ```

   Do not use `-v`: it deletes named volumes.

2. **Back up the data folder** (the host path or volume mounted into the old container). For a bind mount:

   ```bash
   sudo cp -a /path/to/thelounge /path/to/thelounge.backup
   ```

   **The SQLite schema upgrade goes one way by default.** On first start, Horizon Lounge upgrades each user's message history to add a full-text search index and a faster history index. Official, LinuxServer, and `cmd430` builds cannot open an upgraded database directly — keep your backup so you can revert cleanly.

   ::: info Downgrading back to an earlier schema
   An in-progress pull request ([fHori/thelounge#11](https://github.com/fHori/thelounge/pull/11)) adds an automatic downgrade command to convert a Horizon Lounge SQLite database back to the pre-Horizon schema. Until that lands, use the backup you took before upgrading if you need to roll back.
   :::

3. **Note who owns the files.** You need these numbers if your old image ran with custom `PUID`/`PGID`:
   ```bash
   stat -c '%u:%g' /path/to/thelounge/config.js
   ```

---

## A. From LinuxServer (`lscr.io/linuxserver/thelounge`) or `cmd430/docker-thelounge`

Both LinuxServer.io and `cmd430/docker-thelounge` keep data in `/config`, owned by `PUID:PGID` (`911:911` if you never set them). Keep the same `/config` mount and `PUID`/`PGID`, and set `THELOUNGE_HOME=/config`:

**Old compose (LinuxServer / cmd430):**

```yaml
services:
  thelounge:
    image: lscr.io/linuxserver/thelounge:latest
    environment:
      - PUID=1000
      - PGID=1000
      - TZ=Etc/UTC
    volumes:
      - /path/to/thelounge/config:/config
    ports:
      - 9000:9000
    restart: unless-stopped
```

**New compose (Horizon Lounge):**

```yaml
services:
  thelounge:
    image: ghcr.io/fhori/thelounge:latest
    environment:
      - PUID=1000 # match your old PUID:PGID (or 911 if unset)
      - PGID=1000
      - THELOUNGE_HOME=/config # keep using the existing /config mount
      - TZ=Etc/UTC
    volumes:
      - /path/to/thelounge/config:/config
    ports:
      - 9000:9000
    restart: unless-stopped
```

- **Running locked-down without root (`user:`)**: Replace `PUID`/`PGID` with `user: "1000:1000"` (matching the `stat` output above); Horizon Lounge starts directly as that UID/GID without modifying ownership.
- **Alternative without `THELOUNGE_HOME`**: Mount `/path/to/thelounge/config:/var/opt/thelounge` instead of `/config`.

---

## B. From the official image (`thelounge/thelounge`)

> **If you tried migrating before 16 November 2026 and saw no message history:** earlier builds failed to upgrade databases from The Lounge 4.5 (`Migration failed: index network_channel_time already exists`). Failed upgrades roll back without changing data. Pull `:latest` (`docker compose pull`) and start again.

The official image uses the same `/var/opt/thelounge` path and `1000` user as Horizon Lounge. Usually only the `image:` line changes:

**Old compose:**

```yaml
services:
  thelounge:
    image: thelounge/thelounge:latest
    volumes:
      - /path/to/thelounge:/var/opt/thelounge
    ports:
      - 9000:9000
    restart: unless-stopped
```

**New compose:**

```yaml
services:
  thelounge:
    image: ghcr.io/fhori/thelounge:latest
    volumes:
      - /path/to/thelounge:/var/opt/thelounge
    ports:
      - 9000:9000
    restart: unless-stopped
```

**Coming from The Lounge 4.6:** your message history upgrades the same way as older versions and preserves the 4.6 message IDs used by replies. Horizon Lounge is based on The Lounge 4.4.x, so settings added in stock 4.5.x log an `Unknown key` warning on startup and are otherwise ignored.

---

## Starting it (both scenarios)

```bash
docker compose pull
docker compose up -d
docker compose logs -f thelounge
```

On first start you should see:

- **Your existing config being used:** `Configuration file: /config/config.js` (Scenario A) or `/var/opt/thelounge/config.js` (Scenario B). If it says `Configuration file created`, the mount or `THELOUNGE_HOME` is wrong — stop and recheck.
- **A database upgrade for each user:** `sqlite messages schema version is out of date ... Running migrations, this can take a while on a large history.`

**Search is slower briefly after first start.** Users can connect right away while the full-text search index builds in the background per user (progress appears in the container logs). If restarted mid-index, it resumes where it left off.

### Managing users

```bash
docker compose exec thelounge thelounge add <name>
docker compose exec thelounge thelounge reset <name>
docker compose exec thelounge thelounge list
```

---

## Troubleshooting

- **User loads with no message history and logs show `Migration failed`:** Pull the latest image (`docker compose pull`) and restart. Your history was rolled back untouched.
- **Empty instance or setup screen:** The container is not seeing your existing folder. Verify the right-hand side of your `volumes:` mapping and `THELOUNGE_HOME=/config` in Scenario A.
