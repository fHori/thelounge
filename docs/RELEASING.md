# Releasing

Releases are cut by the **Release** workflow (`.github/workflows/cut-release.yml`).
It tests the commit and builds the images side by side, then bumps
`package.json`, tags, publishes the images and creates the GitHub Release with
notes. Tests that master's CI already passed on that commit are not run again. Nothing else creates
versioned images. The version scheme and the image tag policy are defined in
`scripts/release/version.mjs`.

Keep master releasable. Every merge is published as `:edge`, and other builds
that follow this fork track master directly.

## Versions

Versions are `YEAR.FEATURE.PATCH`, tagged `vYEAR.FEATURE.PATCH`:

- **FEATURE** goes up for a release with new features (a merged `feat/` or
  `docker/` branch) or a storage schema change: `2026.11.2` -> `2026.12.0`.
- **PATCH** goes up for anything else: fixes, dependency updates and
  base-image refreshes: `2026.12.0` -> `2026.12.1`.
- The first feature release of a new year is `YEAR.1.0` (`2027.1.0`). Patches
  keep their year: a fix to `2026.14.3` in January is `2026.14.4`.

So `2026.14.3` is the 14th feature release of 2026 with three fix releases on
top. (Releases up to 2026.11 used the month as the middle number; the count
continues from there.) Release candidates are `YEAR.FEATURE.PATCH-rc.N`.

A major of 2000 or more can never be a stock The Lounge version, so fork tags
do not collide with the inherited stock tags (`v4.4.3` and earlier), and they
sort above all of them. The stock base (currently 4.4.3) is named in every
release's notes.

## Image tags (`ghcr.io/fhori/thelounge`)

| Tag              | Meaning                                                            | Moves?                               |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------ |
| `latest`         | Newest stable release                                              | On each release that is the newest   |
| `2026.11`        | Newest patch of that feature release (fixes, base-image refreshes) | Within that feature release          |
| `2026.11.0`      | Exactly that release                                               | Never (immutable)                    |
| `next`           | Newest release candidate                                           | On each pre-release                  |
| `2026.12.0-rc.1` | Exactly that release candidate                                     | Never                                |
| `edge`           | Latest master commit, never older than the newest release          | On every merge and release on master |
| `sha-abc1234`    | The image built from that commit                                   | Never                                |

Pin an exact version (`2026.11.0`) if you want to choose when you upgrade.
Pin a feature release (`2026.11`) to get fixes and security rebuilds without
feature changes.
Use `latest` to follow releases.

`thelounge --version`, the start-up log and the Help page show the version.
Images also show the commit, for example `v2026.11.0 (1a2b3c4)`. The labels
`org.opencontainers.image.version`, `.revision` and `.base.digest` say the
same thing (`docker inspect`).

## Cut a release

Actions > Release > Run workflow, on `master`:

- **bump** `auto`: a feature release if anything merged since the last
  release is a feature or changes the storage schema, otherwise a patch.
  The run summary says when it is a feature release. `feature` or `patch`
  force one or the other.
- **version**: an explicit version, overriding bump.
- **prerelease**: cut a release candidate (`-rc.N`). It publishes `:next` and
  the exact tag, never `:latest`, and the GitHub Release is marked as a
  pre-release. Running the workflow again without the box finalises it.
- **dry_run**: run the tests, build both images and write the release notes
  to the run summary, but push, tag and publish nothing. Use it first. A dry
  run may also start from another branch, to try out changes to the workflow.

## Release notes

The notes list the pull requests merged since the previous release, one line
each, titled by the pull request's title. They are grouped by the branch name's
first part:

| Section      | Branches                                                 |
| ------------ | -------------------------------------------------------- |
| Features     | `feat/`, `docker/`                                       |
| Fixes        | `fix/`, `hotfix/`                                        |
| Performance  | `perf/`                                                  |
| Storage      | `storage/`, `sqlite/`                                    |
| Security     | `security/`                                              |
| Dependencies | `dependabot/`, `deps/`                                   |
| Maintenance  | `chore/`, `ci/`, `build/`, `refactor/`, `docs/`, `test/` |

A squash merge keeps no branch name in git, so the notes ask GitHub which pull
request it came from (with `gh`, and a token). Without one they fall back to
the commit subject, and squash merges land under "Other changes".

Anything else lands under "Other changes". Each line links to its pull
request, as long as it was merged from a branch of this repository. So the way to get good notes is to
name branches with one of these prefixes and give pull requests a title that
reads well on its own; that title is the line in the notes.

If message storage code changed, the notes start with a warning to back up
before upgrading. The first release's notes start where this fork branched off
(`firstReleaseBase` in `scripts/release/version.mjs`).

To see the notes before releasing, either run the Release workflow with
`dry_run` (they are in the run summary), or locally:

```sh
node scripts/release/notes.mjs --from v2026.11.0 --to origin/master --version 2026.11.1
```

You can still edit the notes on GitHub after the release.

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens pull requests every Monday: one
grouped pull request for minor and patch npm updates, one for GitHub Actions,
and one for the Node.js base image digest. Major npm versions come one per pull
request; major Node.js versions are not proposed. New package versions are
only picked up after three days. These pull requests are merged like any
other and reach users with the next release, under "Dependencies".

## Hotfix

If master is releasable, cut a release with bump `patch`.

To fix an older line while master has moved on, create a `release/2026.11`
branch from the tag, merge the fix into it, and run the workflow on that branch
with bump `patch` or an explicit version (`2026.11.2`). The release is not
tagged `latest` unless it is newer than every other release.

## Weekly base-image refresh

The **Refresh base image** workflow runs every Monday. If
`node:22-bookworm-slim` has a new digest since the newest release was built,
it cuts a new release of the same code on the new base. The bump is set in
`refresh.yml`, `patch` by default, so `2026.11.0` becomes `2026.11.1` and
`:2026.11` and `:latest` move to it. The notes of that release say that only
the base image changed. When the base has not changed, or there is no release
yet, the workflow does nothing.

## If a run fails

- Use **Re-run failed jobs**. Every step can safely run again: a tag that an
  earlier attempt pushed is reused, and an existing GitHub Release is updated.
- A tag without a GitHub Release blocks new releases. To finish it, run the
  workflow with `version` set to that tag; this builds, publishes and
  releases the tag. Or delete it (see below).
- "Re-run all jobs" plans again. With the block above it stops instead of
  skipping to the next number.
- If the push of the version commit fails because master moved, run the
  workflow again. The new commits have to be tested first.

## Roll back

For users: switch the image back to the previous exact version
(`ghcr.io/fhori/thelounge:2026.11.0`). If the bad release migrated the
message database, restore the backup of `logs/` taken before the upgrade.
An older version may not read a migrated database.

To withdraw a bad release:

1. Point `latest` (and the line tag) back to the previous release:
   `docker buildx imagetools create -t ghcr.io/fhori/thelounge:latest ghcr.io/fhori/thelounge:2026.11.0`
2. `gh release delete v2026.11.1 --cleanup-tag` (or mark it as a pre-release
   on GitHub, so the update check skips it).
3. Optionally, delete the package version on GitHub (Packages > thelounge >
   versions).
4. Fix the problem and cut a new release. Do not reuse the number.

## Setup notes

- The workflows only use `GITHUB_TOKEN`; there are no secrets to set.
- The version commit is pushed to master by `github-actions[bot]`. If master
  gets branch protection that requires pull requests, either let GitHub
  Actions bypass it, or set `COMMIT_BUMP: "false"` in `cut-release.yml`. Then
  the tag goes on the tested commit and only the image carries the version.
  `package.json` in git keeps the old one.
