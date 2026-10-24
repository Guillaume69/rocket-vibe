# Canaries

WhatsApp, Slack and Teams are reached through surfaces their makers do not publish for third parties, and these can move without notice. A daily workflow checks the ones that can be checked without an account and opens an issue when one moved. Back to [index.md](index.md); the decision is in [../decisions.md](../decisions.md) ("Canaries watch the private protocols").

## How it runs

`.github/workflows/canaries.yml` runs `node scripts/canaries/run.mjs` every day at 05:17 UTC and on `workflow_dispatch`, on GitHub's runners. A push touching `scripts/canaries/` runs only their unit tests (`scripts/canaries/canaries.test.mjs`), never the live checks.

Each check answers `ok`, `broken` or `notice`. `scripts/canaries/issues.mjs` keeps one issue per provider, titled `Canary: WhatsApp`, `Canary: Teams` or `Canary: Slack` and labelled `canary`. It opens the issue on the first broken check, comments the day's table on it while the provider stays broken, and closes it with a comment once every check passes again. A `notice` never opens an issue, and any broken check fails the run.

**What a check expects is read from the code, not copied into the canary**: the vendored WhatsApp stamp, the `sw.js` URL, user agent and revision key, the token tables, the Teams client id, sign-in host and token audiences, the Slack API origin, method list and emoji-datasource version. A refactor can therefore not leave a canary checking stale values. If the canary can no longer find a value it reads, that is itself a broken check (`cannot read … from …`), not a pass.

## What is checked

| Provider | Check | Broken when |
|---|---|---|
| WhatsApp | `wa.sw-revision` | `https://web.whatsapp.com/sw.js`, fetched with the engine's own headers (`crates/rv-whatsapp/src/version.rs`), stops answering 200 or stops carrying `client_revision` followed by digits (`parse_sw_js`). The engine does not connect without that number (`fallback_on_failure: false`). |
| WhatsApp | `wa.whatspec` | whatspec's `generated/manifest.json` names a WhatsApp Web version other than the vendored stamp (`wacore/src/version/generated.rs`): a new extraction is out, and the vendored schemas and tables should be regenerated from it. |
| WhatsApp | `wa.tokens` | whatspec's binary token tables or dictionary version differ from `wacore/binary/src/tokens.json` and `DICT_VERSION`. |
| WhatsApp | `wa.drift` (notice) | Never: it reports how far live WhatsApp Web is past the vendored stamp. The engine sends the live revision; only the schemas carry the stamp's age. |
| Teams | `teams.endpoints` | Microsoft's `organizations` OpenID configuration names other device-code or token endpoints than the ones `crates/rv-teams/src/auth.rs` calls. |
| Teams | `teams.device-code <host>` | A device code for the apps' client id and one of its six token audiences (Skype spaces, the aggregator, presence, Substrate, templates, Graph) is refused, or lacks a field sign-in reads. |
| Teams | `teams.token` | Polling a bogus device code stops answering 400 `invalid_grant`, for example when the client is no longer allowed the device-code grant. |
| Teams | `teams.authz` | The skype-token exchange (`AUTHZ`) answers anything but 401 without a token. |
| Slack | `slack.method <name>` | One of the Web API methods in `SlackMethod` (`packages/provider-slack/src/client.ts`) answers anything but `not_authed` without a token (`unknown_method` or `method_deprecated`: retired). |
| Slack | `slack.emoji` (notice) | Never: it reports a newer emoji-datasource than the one the Slack emoji names were generated from. |

## Out of reach

Anything behind a session needs an account the project does not have: the Teams skype token and its region routes, message and Trouter shapes; Slack's boot-page token scrape, the `d` cookie and RTM frames; WhatsApp's stanzas after pairing, app-state sync and media. Personal Teams is a different service, not a stand-in. A Slack test workspace would allow an authenticated Slack canary.

## Sources

- .github/workflows/canaries.yml
- scripts/canaries/run.mjs
- scripts/canaries/issues.mjs
- scripts/canaries/lib.mjs
- scripts/canaries/whatsapp.mjs
- scripts/canaries/teams.mjs
- scripts/canaries/slack.mjs
- scripts/canaries/canaries.test.mjs
- crates/rv-whatsapp/src/version.rs
- crates/rv-whatsapp/wacore/src/version.rs
- crates/rv-teams/src/auth.rs
- packages/provider-slack/src/client.ts
