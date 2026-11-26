# Running The Lounge in Docker

The image keeps all data (configuration, users, message history, uploads) in
one folder, `/var/opt/thelounge`, and serves on port 9000. By default it runs
as uid:gid `1000:1000`, like the official image, so a data folder from that
image can be mounted as is.

## Image tags

Versions read year, feature release, fix: `2026.12.1` is the 12th feature
release of 2026 with one fix on top. The middle number goes up when a release
adds features or changes how messages are stored; the last one goes up for
fixes, dependency updates and base-image security rebuilds.

| Tag              | Use it to                                                        |
| ---------------- | ---------------------------------------------------------------- |
| `latest`         | Follow every release                                             |
| `2026.12`        | Get fixes and security rebuilds of that release, no new features |
| `2026.12.1`      | Stay on exactly that release until you change it                 |
| `edge`           | Run the newest unreleased changes from `master`                  |
| `preview-<name>` | Try a change before it's merged, when asked to                   |

Back up your data before moving to a new feature release: the release notes
say when it changes message storage. More in [RELEASING.md](RELEASING.md).

## Environment variables

| Variable         | Default              | Meaning                                                      |
| ---------------- | -------------------- | ------------------------------------------------------------ |
| `PUID`           | `1000`               | User id The Lounge runs as.                                  |
| `PGID`           | `1000`               | Group id The Lounge runs as.                                 |
| `UMASK`          | unset                | Octal umask for the files The Lounge creates, such as `002`. |
| `THELOUNGE_HOME` | `/var/opt/thelounge` | Data folder inside the container.                            |

`PUID` and `PGID` can be any numbers; they need no matching user in the image.
They only apply when the container starts as root, which it does unless you
set `user:` / `--user` (see [Running as non-root](#running-as-non-root)).

When `PUID` or `PGID` is set and the data folder belongs to someone else, the
container hands the whole folder to `PUID:PGID` on start, and logs that it
does so. This happens once: later starts only look at the owner of the folder
itself, so a large history does not slow every start down. It never follows
symbolic links out of the folder. Files you create in the folder from outside
the container afterwards keep their own owner.

Without `PUID`/`PGID`, ownership is left alone, except that an empty,
root-owned folder (what Docker creates for a bind mount whose host path does
not exist yet) is given to `1000:1000`.

### Data in `/config`

If `THELOUNGE_HOME` is left at its default, `/var/opt/thelounge` holds no data
(no `config.js` and no `users` folder) and `/config` does, the container uses
`/config` and logs `found data in /config ... using /config`. If both hold
data, it uses `/var/opt/thelounge` and logs that `/config` was ignored. Set
`THELOUNGE_HOME=/config` to make the choice explicit, which is recommended.

## Fresh install

```yaml
services:
  thelounge:
    image: ghcr.io/fhori/thelounge:latest
    volumes:
      - ./thelounge:/var/opt/thelounge
    ports:
      - 9000:9000
    restart: unless-stopped
```

Then create a user:

```bash
docker compose exec thelounge thelounge add <name>
```

## Coming from a `/config` + `PUID`/`PGID` image

Linuxserver-style images keep the data in `/config`, owned by `PUID:PGID`
(`911:911` when they were not set). Keep the mount and the variables, and
change the image:

```yaml
services:
  thelounge:
    image: ghcr.io/fhori/thelounge:latest
    environment:
      - PUID=1000 # same values as before; 911 if you never set them
      - PGID=1000
      - THELOUNGE_HOME=/config
      - TZ=Etc/UTC
    volumes:
      - /path/to/thelounge/config:/config
    ports:
      - 9000:9000
    restart: unless-stopped
```

## Unraid (`nobody:users`, 99:100)

```yaml
services:
  thelounge:
    image: ghcr.io/fhori/thelounge:latest
    environment:
      - PUID=99
      - PGID=100
      - UMASK=002
    volumes:
      - /mnt/user/appdata/thelounge:/var/opt/thelounge
    ports:
      - 9000:9000
    restart: unless-stopped
```

## Running as non-root

Setting `user:` (or `docker run --user`) starts the container as that user
straight away. Nothing is changed in the data folder, which must already be
writable by that user, and `PUID`/`PGID` are ignored (the log says so). This
is the variant for locked-down setups:

```yaml
services:
  thelounge:
    image: ghcr.io/fhori/thelounge:latest
    user: "1000:1000" # owner of ./thelounge
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    volumes:
      - ./thelounge:/var/opt/thelounge
    ports:
      - 9000:9000
    restart: unless-stopped
```

A read-only root filesystem works in every mode: The Lounge only writes to its
data folder.

Starting as root with `PUID`/`PGID` needs these capabilities (all in Docker's
default set):

- `SETUID` and `SETGID`, always, to switch to `PUID:PGID`. Without them the
  container stops with an error that says so.
- `CHOWN`, and `DAC_READ_SEARCH` if some folders are not readable by root,
  only for the start that changes the owner of the data folder.

**Kubernetes and OpenShift.** Run as non-root (`runAsUser`, or the uid
OpenShift assigns). The image's data folder is writable by group 0, so an
arbitrary uid in group 0 works without a volume; with a volume, set `fsGroup`
(or give the volume to that uid) so it is writable.

## Command line

The `thelounge` command runs The Lounge's command line as the same user as the
server, so files it creates belong to that user even though `docker exec`
starts as root:

```bash
docker compose exec thelounge thelounge add <name>
docker compose exec thelounge thelounge reset <name>
docker compose exec thelounge thelounge list
docker compose exec thelounge thelounge storage vacuum
```

Commands can also run in a one-off container, which takes the same
`PUID`/`PGID`/`THELOUNGE_HOME`:

```bash
docker run --rm ghcr.io/fhori/thelounge:latest --version
docker compose run --rm thelounge add <name>
```

## Stopping

`docker stop` sends SIGTERM, which The Lounge handles: it disconnects from IRC
and exits, normally within a second. Open browser connections can hold it up
to three seconds, after which it exits with status 1.
