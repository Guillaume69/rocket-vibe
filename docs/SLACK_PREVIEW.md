# Experimental Slack browser preview

Android, GTK and SwiftUI can import an encrypted Slack session, then browse joined
conversations and paged plain-text history. The helper is a developer command;
packaged desktop sign-in and phone-only acquisition remain missing. Sessions stay
in memory; saved accounts, RTM/live updates, sending, threads, files, calls and push
are not implemented. Real Slack sign-in with this new helper still needs qualification.

## Try it

1. On the app login screen, activate the RocketVibe icon nine times, with no gap
   longer than two seconds. Select Slack in the experimental provider selector.
2. Copy the public pairing code from the Slack panel.
3. On a computer with Node 24 and Edge, Chrome or Chromium, run this from the repo:

~~~sh
node scripts/slack-browser-signin.mjs
~~~

4. Sign in normally in the fresh Slack browser window, including SSO/MFA if needed.
   Open the workspace in the **web client** if Slack offers its desktop application.
   A separate local pairing page opens in your usual browser.
5. Wait for a verified workspace to appear on the local page. Select the workspace,
   paste the public pairing code there, and prepare/copy the encrypted response.
6. Paste that response into the same native Slack panel and import it within five
   minutes. Its workspace/user identity is checked again against Slack by the app.
7. Browse a channel and a DM, load more history, then disconnect. Use Ctrl+C or close
   the fresh Slack browser when done. The helper also stops after twenty minutes.

Android can import the encrypted response prepared on a development computer.
Switching providers, hiding experiments, leaving the panel or disconnecting closes
pending reads and invalidates the old pairing. Copy a new code after reconnecting.
If import succeeds but authentication fails, disconnect and pair again; successful
cryptographic import already consumed the old private key.

## Session boundaries

Only a fresh helper-owned profile is inspected. Slack handles passwords and MFA;
the helper reads the original HttpOnly d cookie and localConfig_v2 workspace tokens
on Slack web-client pages through loopback CDP. A narrow inline boot-token fallback
covers the selected workspace when storage lacks a token. Internal Slack layouts
can change; unsupported acquisition reports a static error instead of guessing.
Each token/cookie pair is validated using auth.test at the fixed Slack API origin.
The local page exposes validated workspace names, public keys and encrypted codes,
never raw tokens/cookies. No RocketVibe server receives the pairing exchange.

X25519, HKDF-SHA256 and AES-256-GCM protect a provider-specific, one-use transfer.
Only the recipient private key can open it. Transfer lifetime is five minutes; the
native preview has a local maximum lifetime of one hour, shortened by a known
cookie expiry. This is a preview limit, not a claim about Slack token expiry. It
refuses requests thirty seconds before that limit. Slack can revoke a session sooner.
There is no refresh attempt or upstream logout/revocation on disconnect.

Normal browser authentication cache can exist in the temporary profile while it
runs. Shutdown removes that exact profile; an OS/process crash can leave a directory
requiring cleanup. The helper never exports credentials to files or prints response
captures. Rust zeroizes retained key/token buffers; JavaScript cannot guarantee
physical zeroization of every string copy. The local pairing server uses a random
capability path, exact Host/Origin checks, no-store responses and a restrictive CSP.

## Test checklist

Check sign-in/MFA, correct workspace selection, channel and DM history, paging,
wrong-panel or stale response rejection, provider switching and disconnect. Share
only the static error code and which step failed. Do not share tokens, cookies,
pairing responses, workspace/member identifiers or message contents.

~~~sh
# Browser transport and profile cleanup only; performs no sign-in:
node scripts/slack-browser-signin.mjs --smoke

# From apps/mobile:
npx tsc --noEmit
npm test

# From the repo, the standard Fedora desktop workflow:
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 apps/desktop/scripts/build.sh
~~~

Synthetic crypto and transport tests do not qualify actual workspace sign-in,
Enterprise Grid or organizational restrictions. The user can perform the live
acceptance test; no account credentials were used during implementation.

## Sources

- scripts/slack-browser-signin.mjs
- scripts/slack/browser.mjs
- scripts/slack/session.mjs
- scripts/slack/server.mjs
- apps/mobile/providers/slack/handoff.ts
- apps/desktop/crates/rv-core/src/slack_handoff.rs
- [Provider handoff](protocol/SLACK_SESSION.md)
- [Slack auth.test](https://docs.slack.dev/reference/methods/auth.test/)
- [Chromium cookie API](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-getCookies)
