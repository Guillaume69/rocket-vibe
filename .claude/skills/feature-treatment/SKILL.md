---
name: feature-treatment
description: Ship a finished rocket-vibe feature or fix branch the full way - rebase onto master, run a max-effort multi-agent code review, fix everything confirmed, update the docs (brain), pass each touched app's gate, merge into master, optionally cut a release, clean up the worktree. Use when the user says "feature treatment", "treat this branch", "review and merge this feature", or names a worktree/branch to ship.
---

# Feature treatment

The pipeline a finished branch goes through before it lands: **rebase → max review
→ fix → update docs → gate → merge → release → clean up**. Nothing merges without
an adversarial review and a green gate.

The branch comes from the argument (a branch or worktree name). If none is given:
`wt list` - the candidate is the non-`master` branch with commits ahead, its
worktree under `../rocket-vibe.worktrees/<branch>`. Ask if more than one fits.

Which apps it touches decides the lenses and the gate:
`git diff --name-only master...<branch> | cut -d/ -f1-2 | sort -u`.

## 1. Rebase onto master

```bash
cd ../rocket-vibe.worktrees/<branch>
git fetch origin && git rebase origin/master
```

Resolve conflicts if any (the `resolving-merge-conflicts` skill). The branch must
sit on master's tip so the review and the merge see only this branch's diff. If
the branch was already pushed, rebasing is still fine here: it is ours and not yet
merged.

## 2. Max-effort review (parallel finders)

The review diff, without the generated files:

```bash
git diff master...HEAD -- . ':(exclude)apps/mobile/package-lock.json' \
  ':(exclude)apps/desktop/Cargo.lock' ':(exclude)apps/mobile/db/migrations/meta/*' \
  ':(exclude)apps/desktop/crates/rv-core/data/emojis.tsv'
```

Spawn **independent finder subagents in parallel** (one message, several Agent
calls), each over the same diff with a different lens. Scale to the change (4-6 is
typical; drop the lenses for an app the branch doesn't touch):

- **Correctness** - line by line: inverted conditions, off-by-one, missing await,
  swallowed errors, races between the socket and the REST call, ordering, state
  left behind on an error path, a response shape the caller doesn't expect.
- **Rocket.Chat protocol** - every assumption about the server checked against
  `CLAUDE.md`'s Rocket.Chat facts: 401 only means unauthenticated (and never
  on anonymous calls), `rooms.media` + `rooms.mediaConfirm` with local dedup,
  REST to act and DDP to listen (no DDP `call`), the 10/min rate limit,
  `chat.syncMessages` per room and one type at a time, avatar etags in query,
  envelopes before trusting a status. Anything new it relies on that is not in
  that list must be probed on the test server, not assumed.
- **Security / secrets / data** - no secret in the repo or in logs, tokens
  (`rc_uid`/`rc_token`) only sent to the server they belong to, deep links and
  `rocketvibe://` params validated, the Jitsi WebView's origin lock intact,
  E2EE keys never leaving the process, local data purged on logout.
- **Platform constraints** - mobile: native components only (no UI kit, no
  WebView, no `@gorhom/bottom-sheet`, no `react-native-markdown-display`), native
  modules over pure-JS polyfills, native changes through a config plugin (never
  `android/`), strict TS with no implicit `any`, every UI string in
  `ui/messages.ts` for both `fr` and `en`. Desktop: GTK work on the main thread
  only, rv-core free of UI, nothing clippy `-D warnings` will refuse, behaviour
  that differs on Windows/macOS.
- **Reuse / simplify / altitude** - does new code re-implement a helper that
  exists (in `lib/`, `ui/`, `rv-core`)? Copy-paste between sibling screens? A
  special case where the general path would do? Comments that explain what the
  code does (the repo writes none)?
- **Tests / parity / docs** - do the tests cover the new branches (error paths,
  empty state, reconnection, the retry)? A test that passes without printing its
  side effect is empty, not green. A desktop UI change: is there a smoke or e2e
  check? The changelog entry and README line the change needs. Parity: does
  `brain/parity.md` carry a row for each visible change, with each app's status
  true to its code? A feature shipped in one app with no row saying the others
  owe it fails the review.

Each finder returns `{file, line, severity, summary, failure_scenario}` objects,
verified (quote the line), most severe first, and fixes nothing. Optionally run
one **sweep** finder with the merged list, hunting only for gaps.

## 3. Fix what's confirmed

Re-verify every claim before fixing: finders surface plausible-but-wrong items.
Fix every confirmed correctness / protocol / security issue and the worthwhile
quality ones. Real but out of scope: a line in `apps/mobile/WORKSTREAMS.md` (its
post-audit findings section) or `apps/desktop/docs/FEEDBACK.md` ("Found while fixing"), not
dropped.

Fixes go on top as new layers, never amended into reviewed commits, and keep the
layer order: a mechanical move apart from the behaviour it enables, the behaviour,
then its tests, then its docs. Subjects start with the branch:
`[<branch>] fix(<app>): <what the user no longer sees>`.

## 4. Update the docs

Apply the **brain** skill (its "Maintaining" list). The essentials, in the same
branch as the change:

- `brain/`: the feature doc(s) the change touches (`## Mobile` / `## Desktop`
  sections, parity state), a new `brain/features/<name>.md` plus its rows in
  `brain/features/index.md` and `brain/BRAIN.md` for a new feature, the matching
  `brain/architecture/*.md` for a changed subsystem, `brain/decisions.md` for a
  decision taken or surfaced in review, `brain/glossary.md` for a new term. Every
  relative link in a touched doc must resolve. Commit as `docs(brain): ...`.
- `apps/<app>/CHANGELOG.md`: one entry per visible change under "Unreleased",
  in the English Keep a Changelog categories (Added / Changed / Fixed / Removed), in the repo's usual
  `docs(<app>): <the change> in the changelog` commit.
- `brain/parity.md`: the rows the change adds or moves, a status per app,
  and the Open debt list kept in step.
- The app's README, `CLAUDE.md` for a newly
  probed server fact, `ROADMAP.md` for a new decision, ticks in `WORKSTREAMS.md` /
  `FEEDBACK.md`.

## 5. Gate (green before merge)

- **mobile**, from `apps/mobile/`: `npx tsc --noEmit && npm run lint && npm test`.
  A change touching native code or a module also needs a rebuilt dev-client run.
- **desktop**: `apps/desktop/scripts/build.sh`; for UI changes,
  `scripts/smoke.sh` and `scripts/e2e.sh` against the test server
  (`cd docker && docker compose up -d && node ../scripts/seed.mjs`).

zsh: redirect a build to a file and test `$?`, or `set -o pipefail`; a `| tail`
reports `tail`'s success.

## 6. Merge

From the main checkout:

```bash
git pull --ff-only origin master
git merge --no-ff <branch> -m "[master] merge <branch>: <one-line summary of what it brings>"
git push origin master
```

End the message with the session's `Co-Authored-By` trailer.

## 7. Release

Ask whether to release now, unless the user already said. If yes, run the
**release** skill for the app(s) the branch touched: **minor** for a feature,
**patch** for fix-only. Several branches often land before one release, so
"merged, released later" is a normal outcome.

## 8. Clean up

```bash
wt remove <branch>          # removes the worktree and the merged branch
```

## Done when

The branch is on master, the docs and changelog reflect it, the gate was green,
the worktree is gone, and a tag is pushed if a release was cut. Report what the
review found and fixed in a line or two, and the version if released.
