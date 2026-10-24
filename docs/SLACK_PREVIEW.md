# Slack (experimental)

Slack is an experimental server kind on Android, GTK and SwiftUI, signed in with a
browser session (the web client's `xoxc` token and its `d` cookie) and saved like any
other account. The earlier read-only preview is gone. How it works:
[Slack session](../brain/architecture/slack-session.md); per-app status:
[parity, section 19](../brain/parity.md#19-experimental-integrations).

## Unlock and sign in

On the login screen, activate the RocketVibe icon nine times, with no gap longer than
two seconds, then pick Slack as the server kind. Hide experimental integrations to
remove it again (saved accounts stay).

- **GTK and SwiftUI**: "Sign in to Slack" opens a temporary browser of the app's own
  (Chromium, Chrome, Edge or Brave must be installed). Sign in there (password, SSO and
  MFA are Slack's); the app closes it and offers a workspace picker when the session
  holds several. Cancel stops the attempt and closes the browser.
- **Android**: either paste a token and `d` cookie, or pair with the developer helper.
  Copy the masked public pairing code, then on a computer with Node 24 and Edge, Chrome
  or Chromium run `node scripts/slack-browser-signin.mjs` from the repo, sign in in the
  fresh browser it opens (use the web client if Slack offers its desktop app), select
  the verified workspace on the local pairing page, paste the pairing code there and
  copy the encrypted response back into the app within five minutes. The helper stops
  after twenty minutes; `--smoke` checks its browser transport without signing in.

Either way the app checks the workspace and user with `auth.test` before saving the
account. The session lives until Slack refuses it; there is no refresh, and signing
out is local (it does not sign the browser out).

## What works

Rooms, unread counts and history, threads, live updates over the RTM socket, typing;
sending, replying (also to the room), editing, deleting, reacting and marking read;
received files as attachments and sending files; search in a room; pins; saved for
later as the app's star; presence (Slack has only online and away); Slack emoji, skin
tones and custom emoji; huddles as call cards, opened in Slack's web app (on GTK Linux
in an app window already signed in, elsewhere in the system browser).

## What does not

Room info and settings, members, leaving, favorites, quotes, scheduled messages, the
account and profile screens (so no status text), push when the app is killed,
end-to-end encryption and native huddle media. Android has no phone-only sign-in, the desktops no
pasted-session fallback. Installed Android and macOS behaviour is not qualified yet.

When reporting a problem, share the static error code and the step that failed, never
tokens, cookies, pairing responses, workspace or member identifiers, or message text.

## Sources

- scripts/slack-browser-signin.mjs, scripts/slack/browser.mjs, scripts/slack/session.mjs, scripts/slack/server.mjs
- apps/mobile/ui/slackSignIn.tsx, apps/mobile/providers/slack/handoff.ts, apps/mobile/providers/slack/auth.ts, apps/mobile/providers/slack/index.ts (`SLACK_CAPABILITIES`)
- crates/rv-slack/src/browser_login.rs, apps/desktop/crates/rv-gtk/src/login.rs, apps/desktop/macos/Sources/RocketVibe/LoginView.swift
- [Provider handoff](protocol/SLACK_SESSION.md)
