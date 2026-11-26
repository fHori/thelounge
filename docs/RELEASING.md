# Releasing

Releases are automated by `.github/workflows/cut-release.yml` on `master`. The workflow tests the target commit, builds multi-arch container images, bumps `package.json`, creates the git tag, publishes `ghcr.io/fhori/thelounge`, and drafts the GitHub Release notes.

Keep `master` releasable — every merge to `master` also updates the `:edge` tag.

To let people try a change before it's merged, push a `preview/<name>` branch (from `master`) and merge the change into it: each push publishes `:preview-<name>`. Releases never include it.

## Versioning

Versions follow `YEAR.FEATURE.PATCH` (tagged `vYEAR.FEATURE.PATCH`):

- **FEATURE** increments when a release adds features (`feat/`, `docker/`) or changes message storage schema: `2026.11.2` -> `2026.12.0`.
- **PATCH** increments for bug fixes, dependency bumps, and base-image updates: `2026.12.0` -> `2026.12.1`.
- **New year**: First feature release starts at `YEAR.1.0`; patches continue incrementing on their existing line.
- **Pre-releases**: Tagged as `YEAR.FEATURE.PATCH-rc.N`.

## Image tags (`ghcr.io/fhori/thelounge`)

| Tag                      | Meaning                           | Updates                             |
| ------------------------ | --------------------------------- | ----------------------------------- |
| `latest`                 | Latest stable release             | Moves on each stable release        |
| `2026.11`                | Latest patch on that feature line | Moves within that feature release   |
| `2026.11.0`              | Exact pinned release              | Immutable                           |
| `next`                   | Latest release candidate          | Moves on pre-releases               |
| `edge`                   | Latest commit on `master`         | Moves on every merge to `master`    |
| `sha-abc1234`            | Specific commit build             | Immutable                           |
| `preview-<name>`         | Latest commit on `preview/<name>` | Moves on every merge to that branch |
| `preview-<name>-abc1234` | Specific preview build            | Immutable                           |

## Cutting a release

In GitHub: **Actions → Release → Run workflow** on `master`:

- **`bump`** (`auto` | `feature` | `patch`): `auto` inspects merged PRs/branches since the last tag to pick `feature` vs. `patch`.
- **`version`**: Explicit version string overriding `bump`.
- **`prerelease`**: Publishes an `-rc.N` build to `:next` without moving `:latest`.
- **`dry_run`**: Runs tests, builds images, and previews release notes in the workflow summary without pushing or publishing.

## Release notes grouping

Release notes group merged pull requests by the source branch prefix:

| Section      | Branch prefixes                                          |
| ------------ | -------------------------------------------------------- |
| Features     | `feat/`, `docker/`                                       |
| Fixes        | `fix/`, `hotfix/`                                        |
| Performance  | `perf/`                                                  |
| Storage      | `storage/`, `sqlite/`                                    |
| Security     | `security/`                                              |
| Dependencies | `dependabot/`, `deps/`                                   |
| Maintenance  | `chore/`, `ci/`, `build/`, `refactor/`, `docs/`, `test/` |

Preview notes locally before cutting a release:

```sh
node scripts/release/notes.mjs --from v2026.11.0 --to origin/master --version 2026.11.1
```

## Automation & recovery

- **Scheduled updates**: Dependabot runs weekly for npm/Actions/base-image PRs, and `.github/workflows/refresh.yml` cuts a patch release if `node:22-bookworm-slim` publishes a new digest.
- **Failed workflow run**: Use **Re-run failed jobs** (steps are idempotent). If a tag was pushed without a GitHub Release, re-run the workflow with `version` set to that tag.
- **Hotfix on an older line**: Branch `release/YEAR.FEATURE` from the tag, merge the fix, and run the Release workflow on that branch (it will not move `:latest`).
- **Rollback**: Re-point `:latest` to the previous image with `docker buildx imagetools create` and delete or pre-release the broken GitHub tag. Never reuse a published version number.
