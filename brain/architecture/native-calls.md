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
- the first capture missed the TURN step and the SDP; the second one
  (`app.slack.com_huddle2.har` plus a `webrtc_internals_dump.gz` "Create dump", 2026-11-02)
  has the whole signalling WebSocket, decoded with the SDK's own
  [SignalingProtocol.proto](https://github.com/aws/amazon-chime-sdk-js/blob/main/protocol/SignalingProtocol.proto).

**The whole Chime flow, end to end** (second capture):
1. `rooms.join {channel_id, regions, multidevice}` → `call.free_willy` as above (a huddle
   in a channel: `ExternalMeetingId` = `<team>-<call id>-<user>`, `huddle.external_unique_id`
   = the Chime `MeetingId`);
2. WebSocket to `SignalingUrl` with the JoinToken as subprotocol. Each binary frame is one
   type byte then a protobuf `SdkSignalFrame {timestamp_ms, type, <one body>}`; the client
   sends type `0x05`, the server's frames start with `0x02`
   ([DefaultSignalingClient.ts](https://github.com/aws/amazon-chime-sdk-js/blob/main/src/signalingclient/DefaultSignalingClient.ts));
3. the sequence: `PING_PONG`, then `JOIN {protocol_version 2, flags, client_details
   (client_source "amazon-chime-sdk-js", chime_sdk_version 3.32.0, platform, os),
   audio_session_id, wants_compressed_sdp, server_side_network_adaption}` (113 B);
   `JOIN_ACK {turn_credentials {username, password, ttl 300, uris: turn:ice.<cell>.m.chime.aws:3478?transport=udp,
   turns:...:443?transport=tcp}, video_subscription_limit 25, wants_compressed_sdp}`;
   `INDEX {num_participants, at_capacity, supported_receive_codec_intersection}`;
   `SUBSCRIBE {duplex RX, send_streams [{stream_id, group_id, track_label
   "AmazonChimeExpressAudio", media_type AUDIO, attendee_id, max_bitrate_kbps}],
   audio_host (the AudioHostUrl, :3478), audio_muted, compressed_sdp_offer}`;
   `SUBSCRIBE_ACK {duplex, allocations [{stream_id, group_id}], compressed_sdp_answer}`;
   `AUDIO_STREAM_ID_INFO {streams [{audio_stream_id, attendee_id, external_user_id, muted}]}`
   (who is in the huddle), then every ~100 ms `AUDIO_METADATA` (levels), every second
   `CLIENT_METRIC` (sent) and `BITRATES`, `DATA_MESSAGE {topic "awareness-sync-channel"}`,
   a `PING_PONG` every 10 s. No `LEAVE` in the capture (it ends before hanging up);
4. **TURN comes in the JOIN_ACK**: the capture has no request to `TurnControlUrl`, and the
   peer connection is created with
   `iceTransportPolicy: relay`, `bundlePolicy: max-bundle` and that single TURN host
   (webrtc-internals): all media goes through Chime's TURN;
5. **the SDP is compressed**: `deflateRaw` (pako) seeded with the previous SDP of the same
   direction as dictionary, empty for the first offer and answer
   ([ZLIBTextCompressor.ts](https://github.com/aws/amazon-chime-sdk-js/blob/main/src/sdp/ZLIBTextCompressor.ts));
6. the SDP itself is plain WebRTC: client offer `setup:actpass`, server answer `passive`,
   `BUNDLE 0 1` (audio `sendrecv`, video `inactive` until a camera or share), `rtcp-mux`,
   UDP/TLS/RTP/SAVPF; offer codecs Opus, red, G722, PCMU/PCMA, CN, telephone-event, and for
   video VP8, VP9, H264, AV1 with rtx/red/ulpfec; the answer keeps Opus+red and
   VP8/VP9/H264/AV1+rtx; header extensions transport-wide-cc, abs-send-time, sdes:mid,
   rid, ssrc-audio-level (offer only), dependency-descriptor, video-layers-allocation.
   A second offer/answer pair follows once connected (renegotiation).

So the Slack side gives everything a native Chime client needs: credentials, signalling
sequence, TURN, SDP. Still unseen: `LEAVE`, video subscription (another participant with a
camera or a share: `SUBSCRIBE` with `receive_stream_ids` and the `INDEX` source list),
and the screen-share path (`ScreenSharingUrl`, a separate WebSocket).

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
- **auth: an `https://ic3.teams.office.com` bearer** (`scp` `Teams.AccessAsUser.All`) on every
  calling request (cc, conv, broker, `epconv`), read from "with sensitive data" HARs
  (2026-11-02, claims only). **Our own client mints it**: the device-code refresh token
  (client `1fec8e78`) redeemed for `https://ic3.teams.office.com/.default` answers 200 with
  the same `aud` and `scp` (`examples/teams-ic3.rs`, live, 2026-11-02). No FOCI hop is
  needed, unlike the web window. Whether the calling stack accepts our client's token is
  not yet proven: the only harmless GET available, an expired broker `subscribe` link,
  answers 404 `subCode 1001` ("message channel does not exist") with or without a token,
  so a first real call settles it;
- **outgoing 1:1 call** (`teams.cloud.microsoft_call_out.har`): one
  `POST https://api-emea.flightproxy.teams.microsoft.com/api/v2/epconv` (201) carrying
  `conversationRequest` (roster `Delta` with a `rosterUpdate` link, properties
  `allowConversationWithoutHost`, `enableGroupCallEventMessages`, and the conversation
  callbacks `conversationEnd`, `conversationUpdate`, `localParticipantUpdate`,
  `addParticipantSuccess/Failure`, `addModalitySuccess/Failure`, `confirmUnmute`,
  `receiveMessage`), `participants {from: {id 8:orgid:me, displayName, endpointId,
  participantId, languageId}, to: [{id 8:orgid:callee, participantId}]}`,
  `endpointCapabilities`, `clientEndpointCapabilities`, `endpointState`, and
  `callInvitation {callModalities: ["Audio"], links {progress, mediaAnswer, acceptance,
  redirection, end}, clientContentForMediaController {controlVideoStreaming, csrcInfo},
  mediaContent {blob: <SDP offer, setup:actpass>}}`. Every callback link is a path of
  the client's own Trouter `SkypeSpacesWeb` registration:
  `https://<trouter host>:3443/v4/f/<registration path>/callAgent/<endpoint>/<random>/...`.
  The answer is a `conversationController` URL plus ~30 conversation links (`leave`,
  `mute`/`unmute`, `addParticipant`, `addModality`, `updateEndpointState`,
  `updateEndpointMetadata`, `subscribe` and `brokerPublish` on the broker,
  `sendMessage`, ...), `state {isMultiParty, isMeetingActivated}` and `callLimits`.
  Then the broker long poll, `updateEndpointMetadata`, and `POST .../leave` (204) to hang
  up. The callee's SDP answer arrives on the `mediaAnswer` callback, i.e. over Trouter:
  these HARs hold no Trouter frames (its socket opened before recording), so its exact
  shape is still owed;
- **incoming call answered** (`..._call_in.har`): `forked/.../attach` (`requireMediaContent:
  false`, an `end` callback and an `additionalActions` conversation request with the same
  callbacks), `incoming/.../progress`, broker subscribe, a conv POST, then
  `incoming/.../accept {callAcceptance {acceptedBy, acceptedCallModalities: ["Audio"],
  links {mediaRenegotiation, transfer, replacement, balanceUpdate, retargetCompletion,
  controlVideoStreaming, updateMediaDescriptions}, mediaContent {blob: <SDP answer,
  setup:active, application sharing rejected with port 0>}}}`, `updateEndpointMetadata`,
  `leave`;
- **group call vs meeting**: both "group call" captures (`..._group_call.har`,
  `..._group_call2.har`) are **calls of a group chat**, not meetings: `epconv` with
  `groupChat {threadId: 19:...@thread.v2}`, `meetingInfo: null`, two `to` participants,
  `callModalities ["Audio", "ScreenViewer"]`, and an offer with one audio, ten
  `main-video`, one `applicationsharing-video` and the `x-data` m-lines. A meeting
  (`meetingInfo`, meetup-join) has not been captured;
- **screen sharing** (`..._screenshare.har`, 2026-11-02, the same `ic3` bearer on every
  request): starting a share is `POST {cc}/cc/v1/active/<call>/.../renegotiate
  {mediaNegotiation {callModalities, sender, links {mediaAnswer, rejection}, mediaContent
  {blob: SDP offer, negotiationTag, mediaLegId}}}` whose offer turns the
  `applicationsharing-video` m-line `sendonly` (audio `sendrecv`, `main-video` `inactive`,
  `x-data` `sendrecv`), plus `conv/<id>/updateParticipantProperties` with a
  `screenSharerAttributes` property; the answer comes back on the `mediaAnswer` callback
  and is confirmed by `POST {cc}/cc/v1/mediaAnswers/.../acknowledge`. Stopping is another
  `renegotiate` with that m-line rejected (one payload type, no direction). When the other
  side shares, the far end renegotiates and the client answers on
  `{cc}/cc/v1/negotiations/.../answer {mediaAnswer {mediaContent, clientContentForMediaController
  {controlVideoStreaming, csrcInfo}, links {mediaAcknowledgement}}}` with that m-line
  `recvonly`. The screen is captured at up to 1920x1080, 15 fps (`getDisplayMedia`,
  webrtc-internals);
- **still missing**: the Trouter frames of a call (the `mediaAnswer` on an outgoing call,
  the ring in a fresh session), where the relay (TURN/MRAS) credentials come from (no
  such request in these HARs), a meeting join, and a `chrome://webrtc-internals` dump of a
  Teams call (the 2026-11-02 dump holds only Slack's peer connection);
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

## Implementation status

**Jitsi, desktop audio: built and checked live (2026-11-02).**
- `crates/rv-call` (own workspace, like the provider crates; CI in `providers.yml`): the `CallSignaling`
  trait (`next_event`, `answer`, `local_candidate`, `set_muted`, `leave`, `local_id`) and the Jitsi
  adapter. `jitsi/mod.rs` reads a meeting's join parameters from the host's `config.js` (both the
  object style and docker-jitsi-meet's `config.hosts.muc = 'muc.' + subdomain + ...` assignments;
  `Config::is_jitsi`), with no network code; `jitsi/client.rs`, behind the default `client` feature,
  is the XMPP connection: WebSocket with the `xmpp` subprotocol, SASL ANONYMOUS (kMeet's JWT on the
  URL as `?room=&token=`), resource bind, XEP-0215 TURN servers, the focus asked for the conference
  (retried while `ready='false'`), MUC presence (nick, `SourceInfo`, `audiomuted`), disco#info answered
  with audio-only features (no `rtp:video`, no `dtls-sctp`: Jicofo then offers one `audio` content and
  no data channel), XMPP pings every 25 s. `jitsi/sdp.rs` turns the focus's `session-initiate` into a
  Unified Plan offer: one `sendrecv` section (`mid` = the content name) for this client's microphone,
  then one `sendonly` section per remote audio source (`mid` `r<n>`, `a=msid:<endpoint> <source name>`,
  the bridge's own `jvb` sources skipped); `source-add` appends sections, `source-remove` makes them
  `inactive` with port 0 (never removed), each a local renegotiation. libwebrtc's answer becomes the
  `session-accept` (the first section's codecs, header extensions, our source `<endpoint>-a0`, ICE and
  DTLS `setup='active'`); later candidates go as `transport-info`. A peer-to-peer `session-initiate`
  from another occupant is declined with `session-terminate`, which keeps the call on the bridge.
- `rv-voice` (`call.rs`): `connect_jitsi` (rv-voice-protocol) runs one call: rv-call's session, one
  libwebrtc `PeerConnection` of its own (`PeerConnectionFactory::default`, the ICE servers XEP-0215
  gave), the microphone track from the same `NativeAudioSource` as LiveKit's, each remote track heard
  through `Audio::listen_rtc` under its stream id (the endpoint), participants with the room's display
  names (`Participant.name`), mute (track disabled and the MUC presence updated), deafen, devices,
  volumes.
- rv-core `VoiceController::connect_jitsi` (one start path with LiveKit's `connect`) and
  `voice::discover_jitsi` (the meeting host's `config.js`, 5 s); GTK `native_call.rs`: a Rocket.Chat
  call whose meeting is on a Jitsi Meet server opens a small native call window (who is in the call,
  who speaks, mute, deafen, hang up, length); no sidecar or a failed join opens the meeting's page.
- **Checked live** on meet.barrut.me: login, conference, room join and the audio-only offer with a
  browser in the room (signalling probe `examples/jitsi-join.rs`); then two sidecars in one test room,
  each sending a tone (`RV_VOICE_FAKE_AUDIO=sine`), each heard the other through the bridge (level 0.8,
  speaking) and left cleanly. With a web participant (2026-11-02, Jitsi Meet in Chrome, muted, joined to the
  same test room): the call stayed on the bridge (Jicofo's peer-to-peer offer declined), the browser
  received the native client's Opus and heard it (inbound level 0.37 once the page could play audio:
  an unclicked tab keeps its remote `<audio>` paused by autoplay rules and reports level 0), and the
  browser's hang-up removed it from the native roster at once (a closed tab only leaves when the
  server times it out). Browser to native was not run with a live microphone; two native clients
  hear each other through the bridge. kMeet (2026-11-02): the GTK call path takes kChat calls too, the
  `?jwt=` of the conference answer's URL becoming the XMPP token (`voice::meeting_token`, unit-tested);
  not run live: kChat sits in a cross-origin frame inside kSuite that the browser automation cannot
  drive, and the `kchat-smoke` example needs the user's Infomaniak API token. Not yet run: the GTK window itself against a real Rocket.Chat call (the
  sidecar path under it was), kMeet live, SwiftUI on a Mac, Android on a device, video.
- **SwiftUI (2026-11-02)**: rv-ffi `jitsi_call.rs` exports `start_jitsi_call(meeting_url, display_name,
  title)`, which discovers the meeting (`voice::discover_jitsi`, kMeet's `?jwt=` included) and joins it
  on a `VoiceController` of its own (one sidecar per call, as GTK's window), and `JitsiCallSession`
  (`state`: connected, ended, microphone, deafened, people with name, muted, speaking;
  `set_microphone`, `set_deafened`, `leave`). `CallWindow.show` tries it first when given the account's
  `displayName` (room call button, call card's Join, a Rocket.Chat or kChat ring answered on the open
  account) and opens `NativeCallWindow` (SwiftUI in an `NSWindow`, polled every 300 ms), the
  WKWebView page otherwise; a background account's ring and a profile's call button keep the page.
  Checked by the Linux build of RocketVibeKit's bindings and the macOS CI only.
- **Android (2026-11-02)**: `crates/rv-voice-mobile` (`call.rs`) wraps rv-call over JNI for
  `com.rocketvibe.voice.JitsiCall`: `start` (meeting URL, its host's `config.js` fetched by Kotlin,
  display name, kMeet's token) joins on a Tokio runtime of its own and returns a handle from a
  registry (a late call after `free` finds nothing; no raw pointer crosses JNI); a reader thread polls
  `next` for the session's events as JSON (`local`, `ice`, `offer`, `candidate`, `roster`, `ended`)
  and is the only one to `leave` and `free`; `answer`, `candidate` and `muted` go through the session's
  command channel. rv-call's `webpki-roots` feature adds Mozilla's roots, Android having none
  rustls-native-certs can read. `JitsiSession` (`JitsiCall.kt`) answers the bridge's offer with the
  `livekit.org.webrtc` LiveKit's SDK ships (its own `PeerConnectionFactory` and `JavaAudioDeviceModule`,
  hardware echo canceller and noise suppressor), hears each remote track by its stream id (the
  endpoint) and reads who speaks from the receivers' `audioLevel` three times a second. `VoiceEngine`
  carries it like a LiveKit room (`connectJitsi`: the same snapshot, `VoiceService`, mute and deafen),
  and the call screen (`app/call/[callId].tsx`) joins natively first for a Rocket.Chat or kChat call
  (`lib/call.ts` `nativeJitsi`), showing who is in the call and its controls, then falls back to the
  WebView for good if the join fails. Checked: host and Android cross-compile of the crate, its unit
  tests, the module's Kotlin against LiveKit's WebRTC (`:voice:compileDebugKotlin`); not run on a
  device (an emulator call needs a signed-in Rocket.Chat account).

## Order

Jitsi first (open protocol, a Rust reference, the server offers, two providers at once;
chat.barrut.me's own Jitsi has no token and no TURN to fight), then Chime for Slack
(official open signalling, credentials already reach the client), then Teams 1:1 audio,
Teams meetings and video last.

## Captures still owed

- **kMeet**: one live call in `#testtest` from the kChat app itself (the `/conferences`
  answer's `url` shape, the XMPP `session-initiate`, the TURN servers from XEP-0215).
- **Slack**: nothing blocking (the second capture has credentials, signalling, TURN and SDP).
  Useful later: a huddle with a second participant's camera or a screen share (video
  subscription, the `ScreenSharingUrl` socket) and a `LEAVE`. A huddle opens in its own
  window: Chrome's DevTools setting "Auto-open DevTools for popups" catches it from the start.
- **Teams**: the Trouter frames of a call (a HAR started before Teams loads, or a
  webrtc-internals dump plus the Trouter socket's frames): the outgoing call's
  `mediaAnswer` and the ring of a fresh session; where the relay (TURN/MRAS) credentials
  come from; a meeting join (`meetingInfo`); a webrtc-internals dump of a Teams call (the
  `x-data` channel's messages). The auth audience, the outgoing call's creating request and
  screen sharing are captured (2026-11-02).

## Sources

- apps/desktop/voice/Cargo.toml, apps/desktop/voice/src/audio.rs
- apps/mobile/modules/voice, crates/rv-voice-mobile
- crates/rv-voice-protocol
- docs/MATTERMOST.md (kMeet conferences)
- brain/features/calls.md, brain/architecture/teams.md, brain/architecture/slack-session.md
- crates/rv-teams/examples/teams-ic3.rs (ic3 token probe), crates/rv-teams/examples/teams-foci.rs
- https://github.com/aws/amazon-chime-sdk-js/blob/main/protocol/SignalingProtocol.proto
- https://github.com/aws/amazon-chime-sdk-js/blob/main/src/signalingclient/DefaultSignalingClient.ts
- https://github.com/aws/amazon-chime-sdk-js/blob/main/src/sdp/ZLIBTextCompressor.ts
- Captures 2026-11-02: chat.barrut.me `#test` call, meet.barrut.me/config.js,
  kmeet.infomaniak.com/config.js, `app.slack.com_huddle.har`, `WebRTC Internals.html`,
  `teams.cloud.microsoft*.har` (incl. `_call_out`, `_call_in`, `_group_call`, `_group_call2`)
- https://github.com/jbg/gst-meet, https://docs.rs/crate/lib-gst-meet/latest
- https://github.com/aws/amazon-chime-sdk-cpp, https://github.com/aws/amazon-chime-sdk-js
- https://github.com/brandonp2412/microslop
