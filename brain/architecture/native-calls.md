# Native calls (research, 2026-11-02)

The goal: calls on Teams, Rocket.Chat (Jitsi), kChat (kMeet) and Slack (huddles) carried
by the apps themselves, with no web page, no WebView and no browser: our own signalling
client per provider, our own WebRTC media, the existing call UI. Nothing is built yet; this
page records what the research and the captures established, the architecture chosen, the
order, and the captures still owed. Today's behaviour (a call window on the provider's web
page, Teams' one-time Microsoft sign-in) is in [../features/calls.md](../features/calls.md);
the decision is in [../decisions.md](../decisions.md).

## What the apps already ship

- **Desktop**: the `rv-voice` sidecar (`apps/desktop/voice`) links `livekit` 0.9.3, which
  re-exports `libwebrtc` 0.3.50 as `livekit::webrtc`: a full PeerConnection API (offer and
  answer, SDP, data channels, native audio and video sources). The audio chain in
  `audio.rs` (cpal, echo cancellation, RNNoise, voice gate, per-person mix) does not depend
  on LiveKit. The sidecar speaks JSON lines (`crates/rv-voice-protocol`). GStreamer is not
  linked anywhere in the desktop app.
- **Android**: Vibez voice is the local Kotlin module `modules/voice` over
  `io.livekit:livekit-android`, which bundles its own libwebrtc build with the `org.webrtc`
  PeerConnection API (ROADMAP §4.2 "1b"). `crates/rv-voice-mobile` is only RNNoise over
  JNI. Other providers therefore need no new native WebRTC dependency, and the
  `react-native-webrtc` and Jitsi RN SDK paths ROADMAP §4.2 rejects stay rejected.

## Architecture

- **`crates/rv-call`** (pure Rust, no media): one `CallSignaling` trait (join, leave, the
  local offer or answer, remote descriptions, ICE servers, roster, mute state, data-channel
  messages) with one adapter per protocol: `jitsi`, `chime`, `teams`, and `livekit` (the
  existing Vibez path, untouched).
- **Desktop**: `rv-voice` gains a generic connection mode driving `livekit::webrtc` from the
  adapter, and `rv-voice-protocol` a provider-tagged `connect`. The audio chain, devices,
  noise removal, participant and speaking events, the GTK and SwiftUI voice UI and the ring
  prompt are reused as they are.
- **Android**: `rv-call` over JNI as `rv-voice-mobile` is; a Kotlin `GenericCallEngine`
  beside `VoiceEngine` on the bundled `org.webrtc`; `VoiceService` and the call-style
  notification reused.
- **Fallback**: each adapter replaces the provider's call window only once proven; the
  WebView stays as the fallback until then, after which the ROADMAP §4.2 exception shrinks.

## Rocket.Chat (Jitsi) and kChat (kMeet): one adapter

Both are Jitsi Meet: XMPP over the server's `xmpp-websocket`, a MUC room, the focus
(Jicofo) sends a Jingle `session-initiate` once a second participant joins (alone in the
room no media session opens), the client answers, sources are added and removed with
`source-add` / `source-remove`. Media is plain WebRTC to the bridge (JVB): one BUNDLE,
DTLS-SRTP, the server offering (`a=setup:actpass`, the client answers `active`). The bridge
channel (dominant speaker, receiver video constraints) runs over the SCTP data channel when
`bridgeChannel.preferSctp`, else a `colibri-ws` WebSocket.

**chat.barrut.me** (captured live 2026-11-02, call started in `#test`):
- the provider is the Jitsi app (`video-conference.capabilities` `providerName: "jitsi"`,
  `VideoConf_Default_Provider = jitsi`); `video-conference.start` then
  `video-conference.join {callId, state}` answer `{url, providerName, callId, rid}`;
- the Jitsi server is **self-hosted, `meet.barrut.me`** (docker-jitsi-meet defaults): the
  join URL is `https://meet.barrut.me/RocketChat<call id>` with only hash parameters
  (`config.callDisplayName`, `config.startWithAudioMuted`, `config.startWithVideoMuted`,
  `config.prejoinPageEnabled`, `config.prejoinConfig.enabled`, `userInfo.displayName`,
  `config.desktopSharingChromeExtId`): **no JWT, anonymous XMPP**;
- `config.js`: `hosts.domain = meet.jitsi`, `hosts.muc = muc.meet.jitsi`,
  `websocket = wss://meet.barrut.me/xmpp-websocket` (the client adds `?room=<room>`),
  `bosh = https://meet.barrut.me/http-bind`, `bridgeChannel.preferSctp = true`,
  `p2p.enabled = true` (two people go peer to peer; a native client can disable it in its
  own MUC presence), `flags.sourceNameSignaling`, `sendMultipleVideoStreams`,
  `receiveMultipleVideoStreams` true, no E2EE configuration (the web client reports E2EE
  supported, off);
- the bridge's offer (2026-11-02): `a=group:BUNDLE 0 1 2`, audio `opus/48000/2` +
  `telephone-event`, extmaps ssrc-audio-level and transport-wide-cc; video AV1, VP8, H264,
  VP9 each with rtx, extmaps dependency-descriptor, abs-send-time, transport-wide-cc;
  `m=application UDP/DTLS/SCTP webrtc-datachannel` port 5000; the JVB candidate on UDP 10000
  of the server's public address; the peer connection had **no ICE servers** (no STUN, no
  TURN) and `bundlePolicy: max-bundle`.

**kMeet** (`kmeet.infomaniak.com/config.js`, read 2026-11-02; a live kChat call was not
captured, the kChat app being a cross-origin iframe inside kSuite the tools could not
drive):
- `hosts.domain = kmeet.infomaniak.com`, `hosts.muc = muc.kmeet.infomaniak.com`,
  `websocket = wss://kmeet.infomaniak.com/xmpp-websocket`, `bosh = /http-bind`;
- token auth: `tokenAuthUrl = https://welcome.infomaniak.com/api/components/meet/jwt?room={room}`;
  the `jwt` from `POST /conferences` and `/conferences/<id>/answer` (`docs/MATTERMOST.md`)
  is the XMPP credential, passed as `?room=<room>&token=<jwt>` on the websocket as
  lib-jitsi-meet does;
- P2P off (`enableP2P`, `p2p.enabled` false), `useStunTurn` true, `useTurnUdp` false (TURN
  over TCP/TLS only, the servers announced by XEP-0215 external services),
  `bridgeChannel.preferSctp` true, no E2EE configuration.

Reusable code: [gst-meet / lib-gst-meet](https://github.com/jbg/gst-meet) (Rust, MIT or
Apache-2.0) has the XMPP, Jingle, colibri layers and JWT login; take its signalling half
and plug libwebrtc instead of GStreamer and libnice. The Jingle to SDP translation follows
lib-jitsi-meet's `SDP.js`. Risks: Jitsi E2EE (per-frame keys over XMPP, "insertable
streams") is not LiveKit's frame encryption, so an encrypted Jitsi call is refused at
first. Feasibility high; desktop audio about 3 to 4 weeks, video 2 to 3 more, Android 2 to 3.

## Slack huddles (Amazon Chime SDK)

Confirmed in the user's capture (`app.slack.com_huddle.har`, 2026-11-02, a huddle started
in `#caca`):
- `POST /api/rooms.join` (form: `token`, `channel_id`, `regions`, `multidevice`, the usual
  `_x_*`) answers `call.call_id` and `call.free_willy` = **Chime meeting and attendee
  credentials**: `meeting.MeetingId`, `ExternalMeetingId`, `MeetingArn` (AWS us-east-1
  control plane), `MediaRegion` (`eu-west-3` here), `MediaPlacement.{AudioHostUrl
  (host:3478), AudioFallbackUrl (wss), SignalingUrl (wss://signal.<cell>.m.chime.aws/control/<meeting id>),
  TurnControlUrl (https://<n>.cell.us-east-1.meetings.chime.aws/v2/turn_sessions), ScreenDataUrl,
  ScreenSharingUrl, ScreenViewingUrl, EventIngestionUrl}`, `attendee.{AttendeeId,
  ExternalUserId, JoinToken, Capabilities.{Audio,Video,Content}}`; `huddles.get {huddle_id}`
  reads the huddle (participants, channels, `huddle_link`);
- the signalling WebSocket is `SignalingUrl` with query `X-Chime-Control-Protocol-Version`,
  `X-Amzn-Chime-Send-Close-On-Error`, `X-Amzn-Version`, `X-Amzn-User-Agent`, the JoinToken
  as `Sec-WebSocket-Protocol` (`_aws_wt_session`); binary protobuf frames (first ones 24 B
  each way, then a 152 B join, 288 B join ack, a 2324 B frame carrying the SDP offer);
- the TURN credential request to `TurnControlUrl` is not in the capture (the huddle opened a
  second window), and the `WebRTC Internals.html` saved is the page only: it shows
  getUserMedia audio constraints (`echoCancellation`, `autoGainControl` ideal) but no peer
  connection, no SDP; a "Create dump" JSON is needed for the SDP.

Media is standard WebRTC with the client always offering. AWS publishes the signalling for
custom media stacks: [amazon-chime-sdk-cpp signaling](https://github.com/aws/amazon-chime-sdk-cpp/blob/main/chime-sdk-signaling-cpp/README.md)
(its demo uses libwebrtc) and the `.proto` in
[amazon-chime-sdk-js](https://github.com/aws/amazon-chime-sdk-js/blob/main/src/signalingclient/SignalingClient.ts)
(Apache-2.0), which generate into Rust. The Chime Android SDK's media layer is a closed
binary, not usable. Risks: Slack's terms forbid unofficial clients (the xoxc session is
already that grey zone). Feasibility medium-high; audio about 3 to 5 weeks.

## Microsoft Teams

From the user's HARs (2026-11-01/02, see [teams.md](teams.md) Live and Calls):
- ringing is Trouter `evt` 107 on the `SkypeSpacesWeb` registration; the ringing side calls
  `cc.skype.com` through `api.flightproxy.teams.microsoft.com/api/v2/ep/<host>/...`:
  `forked/.../attach` (registers its Trouter `callAgent` callback links), `incoming/.../progress`,
  `accept {callAcceptance, acceptedCallModalities, mediaRenegotiation links, SDP}`,
  `DELETE .../reject {callEnd}`; the conversation service on `conv.skype.com`
  (`updateEndpointState`, a group call's POST `conv/<id>` with `groupChat.threadId` and
  `meetingInfo`, `updateEndpointMetadata`, `leave`); the broker (`broker.skype.com`) is a
  30 s long poll;
- **the auth these requests carry is unknown**: Chrome's default HAR export drops
  `Authorization` and cookies, and the calling requests in the captures carry no token
  header at all; a "with sensitive data" export is needed to read which token audience the
  calling service wants (only the `aud`/`scp` claims will be kept);
- the SDP (`application/sdp-ngc-1.0`): DTLS-SRTP, shared transport, Opus/G722/PCM, H264/AV1,
  transport-wide-cc, plus Microsoft extensions: an `m=x-data` SCTP channel,
  `a=x-ssrc-range` (100 video SSRCs reserved in a group call),
  `a=x-signaling-fb:* x-message app send:src recv:src,vc`, `a=label:main-audio` /
  `main-video` / `applicationsharing-video`, the profile written `RTP/SAVP`; libwebrtc
  carries it with SDP rewriting both ways;
- the window cannot be signed in for the user: the FOCI exchange to Teams' web client is
  refused (`AADSTS70000`, [teams.md](teams.md) Calls), so native is the only sign-in-free path.

Reference: [Microslop](https://github.com/brandonp2412/microslop) (MIT, Rust core) reports
1:1 audio against Microsoft's Test Call, video partial. Risks: Teams E2EE 1:1 calls and
Premium meeting E2EE are likely unjoinable; Microsoft changes the protocol silently and its
terms forbid unofficial clients. Feasibility medium for 1:1 audio (4 to 6 weeks), low for
meetings with video (2 to 3 months more).

## Order

Jitsi first (open protocol, a Rust reference, the server offers, two providers at once;
chat.barrut.me's own Jitsi has no token and no TURN to fight), then Chime for Slack
(official open signalling, credentials already reach the client), then Teams 1:1 audio,
Teams meetings and video last.

## Captures still owed

- **kMeet**: one live call in `#testtest` from the kChat app itself (the `/conferences`
  answer's `url` shape, the XMPP `session-initiate`, the TURN servers from XEP-0215).
- **Slack**: the TURN session request (`TurnControlUrl`) and a `chrome://webrtc-internals`
  "Create dump" JSON of a huddle, for the SDP.
- **Teams**: the same HARs exported "with sensitive data" (only `aud`/`scp` kept), an
  outgoing 1:1 call (its creating POST and offer), the TURN credential request, ICE
  candidates, a meeting join, and a webrtc-internals dump of a group call (the `x-data`
  channel's messages).

## Sources

- apps/desktop/voice/Cargo.toml, apps/desktop/voice/src/audio.rs
- apps/mobile/modules/voice, crates/rv-voice-mobile
- crates/rv-voice-protocol
- docs/MATTERMOST.md (kMeet conferences)
- brain/features/calls.md, brain/architecture/teams.md, brain/architecture/slack-session.md
- Captures 2026-11-02: chat.barrut.me `#test` call, meet.barrut.me/config.js,
  kmeet.infomaniak.com/config.js, `app.slack.com_huddle.har`, `WebRTC Internals.html`,
  `teams.cloud.microsoft*.har`
- https://github.com/jbg/gst-meet, https://docs.rs/crate/lib-gst-meet/latest
- https://github.com/aws/amazon-chime-sdk-cpp, https://github.com/aws/amazon-chime-sdk-js
- https://github.com/brandonp2412/microslop
