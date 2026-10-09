---
name: release
description: Cut a rocket-vibe release of the mobile app, the desktop app, or both, the whole shebang - docs sweep (each app's CHANGELOG, READMEs, brain/parity.md), version bump in the files that own it, gate, a release/<x.y.z> branch merged into master, the <app>-vX.Y.Z tag pushed, then watch the GitHub workflow until the Release exists with its binaries. Use when the user says "cut a release", "release", "release desktop", "release mobile", or "the whole release shebang".
---

# Release shebang

Everything between "the code is done" and "the GitHub Release exists". There is no
release task: the tag push does the publishing (`.github/workflows/mobile.yml`,
`desktop.yml`), so the value of this skill is getting the files right before the
tag, and watching CI after it.

Each app (mobile, desktop, web, server) has its own version, changelog and tag. A run
can cut one app or several; they share one release branch.

## 1. Pre-flight

- Which app(s)? If not given, list what each has unreleased:
  `git log --oneline <app>-v<last>..master -- apps/<app>` and its changelog's
  "Unreleased" section. An app with nothing there is not released.
- Previous version per app: `git describe --tags --abbrev=0 --match '<app>-v*' master`.
- Pick the next semver: **minor** if the section has an Added entry or a
  visible Changed, **patch** for fix-only.
- Main checkout on `master`, clean, up to date: `git pull --ff-only origin master`.
  Other sessions work on master: never commit the release onto it directly.
- Open the release branch, named after the version (when both apps, the desktop's,
  as with `release/0.6.1` carrying desktop 0.6.1 and mobile 0.5.0):

  ```bash
  wt switch --create release/<x.y.z>     # lands in ../rocket-vibe.worktrees/release/<x.y.z>
  ```

## 2. Docs sweep (against `git diff <app>-v<last>..HEAD -- apps/<app>`)

- **`apps/<app>/CHANGELOG.md`, the unreleased section** must cover every visible
  change since the last tag. Entries are added per branch during development, so
  this is usually a completeness check against the log. Both apps use the
  English Keep a Changelog categories (Added / Changed / Fixed / Removed /
  Deprecated / Security). One entry per change, worded for a user, not a commit subject.
- **READMEs**: `apps/<app>/README.md` (features, prerequisites, scripts) and the root
  `README.md` (CI, secrets, release flow), if the release changes what they say.
- **`brain/parity.md`**: every visible change in the section has its row, with
  a status per app (Android, GTK, SwiftUI) checked in the code, and Open debt
  matches the tables. A release can ship a feature in one app only if its row
  says which apps owe it.
- **`apps/desktop/docs/FEEDBACK.md`**: tick the tester items this release fixes.
- **`CLAUDE.md`**: a Rocket.Chat fact probed during the cycle and not yet recorded.
- **`brain/`**: every feature or subsystem the release changes is described as it
  now works (the **brain** skill's audit, scoped to the touched docs), and
  `brain/stack.md` follows any dependency or toolchain bump in the diff.
- Commit what the sweep changed, one layer per app (`brain/` as its own):
  `[release/<x.y.z>] docs(<app>): ...`, `[release/<x.y.z>] docs(brain): ...`.

## 3. Bump

Per app, one commit `[release/<x.y.z>] chore(<app>): release <x.y.z>` holding:

- **Changelog**: insert `## [<x.y.z>] - <YYYY-MM-DD>` right under the unreleased
  heading (the heading stays, empty), and fix the link references at the bottom:
  the unreleased one now compares from `<app>-v<x.y.z>`, and a new
  `[<x.y.z>]: .../compare/<app>-v<last>...<app>-v<x.y.z>` line goes under it.
  Both apps' unreleased label is `[Unreleased]`.
- **mobile**: `apps/mobile/app.json` `expo.version` and `expo.android.versionCode`
  (= major * 10000 + minor * 100 + patch), then from `apps/mobile/`:
  `npm version <x.y.z> --no-git-tag-version` (updates `package.json` and
  `package-lock.json` together).
- **desktop**: `[workspace.package] version` in `apps/desktop/Cargo.toml`, and the
  workspace crates in `apps/desktop/Cargo.lock` (`rocket-vibe-gtk`, `rv-core`,
  `rv-ffi`, `rv-native`, `rv-voice-protocol`). The voice sidecar is its own
  workspace and follows too: `version` in `apps/desktop/voice/Cargo.toml` and
  `apps/desktop/voice/screen-audio/Cargo.toml`, and the `rv-voice`,
  `rv-screen-audio` and `rv-voice-protocol` entries of `apps/desktop/voice/Cargo.lock`
  (desktop 0.11.0's tag run failed on that lock). CI builds with `--locked`, so a
  stale lock fails every job. The desktop gate below rewrites the main lock if it
  is behind; check that `git diff` of both locks touches only those versions, and
  `cargo metadata --locked` in `apps/desktop/voice` (in the build container).

- **web**: from `apps/web/`, `npm version <x.y.z> --no-git-tag-version`, then
  `npm run build` and commit the rebuilt `dist/` (the version is in the bundle).
- **server**: `[package] version` in `apps/server/Cargo.toml` and the `rv-server`
  entry of the root `Cargo.lock`. Its tag runs `server-release.yml` (gate, Docker
  build, binary archive, release; no image is pushed); the `release/**` branch push
  runs the same without publishing, so wait for it to be green before tagging.
  Release web before (or with) the server: the server embeds `apps/web/dist`.

Then both scripts must agree, or CI will refuse the tag:

```bash
node scripts/version.mjs <app> --tag <app>-v<x.y.z>
node scripts/changelog.mjs <app> <x.y.z>      # prints the release notes; read them
```

## 4. Gate (green before merge)

- **mobile**, from `apps/mobile/`: `npx tsc --noEmit && npm run lint && npm test`.
- **desktop**: `apps/desktop/scripts/build.sh` (fmt, clippy `-D warnings`, tests, in
  the Fedora container).

zsh: a pipe hides the exit code. Redirect to a file and test `$?`, or run under
`set -o pipefail`; never trust `| tail`.

## 5. Merge, tag, push

From the main checkout:

```bash
git pull --ff-only origin master
git merge --no-ff release/<x.y.z> -m "[master] merge release/<x.y.z>: desktop <x.y.z>, mobile <a.b.c>"
git tag <app>-v<x.y.z>                     # lightweight, on the merge commit; one per app released
git push origin master <app>-v<x.y.z> [<other-app>-v<a.b.c>]
```

**At most 3 tags per push**: GitHub creates no tag event at all when a single push
carries more than three tags (the 0.13.0 run pushed four and no release workflow
started). With four apps, push the tags in two pushes, or start the workflows on the
tags with `gh workflow run <app>.yml --ref <app>-v<x.y.z>` (every release job accepts a
dispatch on a tag).

Every commit message ends with the session's `Co-Authored-By` trailer. If master
moved since the pull and the push is rejected, pull again (merge, not rebase:
the merge commit is already there) and re-push; never force.

## 6. Watch the release

```bash
gh run list --workflow <app>.yml --limit 3          # find the tag's run
gh run watch <run-id> --exit-status
gh release view <app>-v<x.y.z>
```

The desktop run builds Linux, AppImage, Windows, macOS (GTK and SwiftUI), then
the `release` job; it takes a while. Expected assets: mobile
`rocket-vibe-mobile-<x.y.z>.apk`; desktop `*.tar.gz`, `*.AppImage`, `*.zip`,
`*-setup.exe`, `*.dmg`. If a job fails, read its log (`gh run view <id> --log-failed`),
fix on a new branch, and re-run the workflow on the tag rather than moving it,
unless the tag points at a broken tree, in which case ask before deleting it.

## 7. Clean up

```bash
wt remove release/<x.y.z>
```

## Done when

The tag(s) are on master's merge commit, the GitHub Release exists with every
expected asset and the changelog section as notes, and the worktree is gone.
Report the version(s) and the release URL.
