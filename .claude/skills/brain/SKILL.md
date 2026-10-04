---
name: brain
description: Use and maintain the brain/ knowledge base - the committed docs describing how rocket-vibe works (both apps' architecture, features across mobile and desktop, the Rocket.Chat contract, decisions, glossary of the French code vocabulary). Invoke when the user asks how/where something works ("how does the upload queue work", "where does catch-up live", "what is salonChaud", "does desktop do X"), when onboarding, or when asked to update, audit, or fix the brain after a change. Read brain/BRAIN.md first; navigate via the indexes, not a whole-tree grep.
---

# The brain

`brain/` is the committed knowledge base: how the two apps work, written so you
can answer without reading the source. Use it as the first stop for understanding,
and keep it true to the code.

## Navigating (to answer a question)

1. Open `brain/BRAIN.md` - the entry index. It has a topic table and a **Find by
   question** table.
2. Drill via the sub-indexes: `brain/architecture/index.md` (the how, per app and
   shared) and `brain/features/index.md` (the what, each feature covering mobile
   and desktop). Don't grep the whole tree; the indexes are the routing layer.
3. Land on the leaf doc. It is self-contained and ends with a `## Sources` list of
   the real code paths - follow those only if the doc isn't enough or you suspect
   drift.
4. A French identifier from the mobile code -> `brain/glossary.md`. Rationale /
   "why" -> `brain/decisions.md`. A verified Rocket.Chat server behaviour -> the
   "Faits sur Rocket.Chat" section of `CLAUDE.md`, summarised in
   `brain/architecture/rocket-chat.md`.

Structure:

```
brain/BRAIN.md                 root index + find-by-question
brain/stack.md  operations.md  glossary.md  decisions.md
brain/architecture/index.md    overview rocket-chat testing e2ee i18n
                               mobile-app mobile-data mobile-transport mobile-native
                               desktop-app desktop-core desktop-gtk desktop-macos
brain/features/index.md        one doc per feature, both apps in each
```

## Maintaining (after a change)

The rule is in `CLAUDE.md` ("Le brain"). The code is the source of truth - if a
doc disagrees with reality, fix the doc.

- A change that makes a brain doc wrong fixes that doc in the **same branch**, as
  its own `docs(brain): ...` layer after the behaviour and its tests.
- New feature -> add `brain/features/<name>.md` (with `## Mobile` and `## Desktop`
  sections), then a row in `brain/features/index.md` and the catalog table in
  `brain/BRAIN.md`. A feature landing on another app updates the existing doc.
  New subsystem -> add or update a `brain/architecture/*.md`.
- Parity ("La parité" in `CLAUDE.md`): every visible feature has its rows in
  `brain/parity.md` with a status for Android, GTK and SwiftUI, checked in each
  app's code. An app that lacks it is `missing` or `partial` and appears under
  Open debt; one that catches up goes to `done` and leaves it. `mapped` only for a
  platform mechanism meeting the same need, with the note saying how.
- New non-obvious decision -> `brain/decisions.md` with its "why". New term or
  French identifier -> `brain/glossary.md`.
- A server fact probed on the 8.5 test server goes in `CLAUDE.md`'s facts first;
  `brain/architecture/rocket-chat.md` links it.
- The other docs keep their own job: changelogs,
  `apps/mobile/WORKSTREAMS.md`, `ROADMAP.md`. The brain links them, it doesn't
  replace them. `apps/mobile/docs/AUDIT.md` is frozen.
- Style: English, dense, skimmable, present tense, normal prose. No em-dashes.
  Cross-link siblings with relative markdown links. Cite source paths instead of
  restating code. End each doc with `## Sources`.

## Auditing (drift check on request)

1. Scope it to the relevant leaf doc(s) - don't re-audit everything.
2. For each, read the `## Sources` paths and confirm the doc's claims still hold
   (table and module names, file locations, behaviour on both apps).
3. Where they diverge, the code wins: correct the doc. Note what you changed.
4. If a subsystem moved or a feature shipped or was removed, update the indexes
   (`BRAIN.md`, the two `index.md`) so navigation stays accurate.
5. Check links: every relative link in a touched doc resolves, every `## Sources`
   path exists.

For a broad audit, fan out read-only agents (one per architecture or feature doc)
that each diff their doc against its `## Sources`, then apply the fixes.
