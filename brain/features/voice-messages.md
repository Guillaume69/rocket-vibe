# Voice messages

A voice message is an audio file recorded from the microphone and sent through the ordinary upload queue, so it gets the same validation, dedup, retry and discard as any attachment ([uploads](uploads.md)). Nothing on the server marks it as "voice": it is an audio attachment that clients play in place. The apps differ in format and in whether the recording waits in the composer.

## Mobile

- **Recording** (`toggleVoice` in `ui/composer.tsx`): the microphone button in the composer's pill asks the microphone permission (`expo-audio`), switches the audio session to allow recording (iOS refuses otherwise and would route playback to the earpiece afterwards), and records with the `HIGH_QUALITY` preset: AAC in `.m4a`, sent as `audio/mp4`. While recording, the round button is "stop" even if text is typed, and the attach button is disabled.
- **Staged, not sent.** Stopping does not send: the recording becomes a staged piece named `vocal-<timestamp>.m4a`, shown above the field with a real player (`AudioPlayer` inside `ui/attachmentPreview.tsx`) so it can be replayed before sending. Text typed meanwhile becomes its caption, and the send button sends it with any other staged files. Removing the chip deletes the recording from the cache.
- An empty recording (no URI) or a refused permission shows an error line above the composer.
- The thread composer has no microphone (it has no attachments, see [threads](threads.md)).
- **Encrypted RocketVibe rooms**: the recording goes through the room's private file outbox like any staged file; its decrypted copy stays in the private cache while a view shows it (`NativeChat.showPrivateFiles`), so the lazily created player finds it.
- **Playback** of any audio attachment, voice included, is `ui/audioPlayer.tsx`: play/pause, a seekable bar, and a frequency visualiser fed by an FFT of the output samples (Android's `Visualizer`, which needs `RECORD_AUDIO`; without it playback still works with idle bars). The player is only created on the first "play": mounting one per visible voice message buffered every file (about 20 MB for twenty messages scrolled past) and leaked the tokenised URL into ExoPlayer. One player plays at a time. Details in [media playback](media-playback.md).

## Desktop (GTK)

- **Recording** (`rv-gtk/src/recorder.rs`): a GStreamer pipeline `autoaudiosrc ! audioconvert ! audioresample ! opusenc bitrate=32000 ! oggmux ! filesink` writes Ogg/Opus to the user cache (`RV_AUDIO_SOURCE` can name another source, a test tone for the smoke tests). The composer swaps its field for a recording bar with the elapsed time, a cancel button and a send button, polling every 250 ms; a pipeline error (no microphone) stops the recording and shows a toast.
- **Finishing** sends end-of-stream through the muxer and waits up to 3 s for it, so the Ogg file is closed properly; a zero-byte file counts as empty ("voice.empty"). Cancelling deletes the file.
- **Staged, not sent.** The recording bar's stop button (`voice.stop`) hands the finished file to the composer's staged files (`Composer::stop_recording` in `rv-gtk/src/composer.rs`), named `message-vocal-<date>.ogg`. Its chip (`rv-gtk/src/staged.rs`) shows the audio icon and a play/pause button (`audio_toggle`, a stream made on the first play and paused when the chip goes) so it can be listened to; the text typed becomes its caption and the send button sends it with any other staged files, through the same path as files (`send_files_in` in `rv-gtk/src/chat.rs`: Rocket.Chat, native or private, room or thread). `mime_of` reports Ogg as `audio/ogg` whatever its codec (`audio/x-opus+ogg` for shared MIME info). A refusal (for example a MIME whitelist without `audio/ogg`) shows the file refusal toast.
- Only the room's composer is wired: the thread page's composer shows the microphone, but no handler receives its recording, which is then deleted.
- **Playback**: audio file cards have a Play button that downloads to the cache, then plays with GTK's `MediaControls` over a GStreamer stream (`audio_player` in `rv-gtk/src/cards.rs`).

## Desktop (SwiftUI)

`VoiceRecorder` in `Composer.swift` records with `AVAudioRecorder` to AAC `.m4a` (44.1 kHz, mono, 64 kbps), after asking microphone access. The field row shows the elapsed time and a cancel button; the stop button (`stopVoice`, `voice.stop`) renames the file `voice-message-<timestamp>.m4a` and stages it with the other files. Its chip plays it (`StagedAudio`, an `AVAudioPlayer` stopped when the chip goes); the draft becomes its caption and the send button sends it like any staged file (`RoomModel.attach`, room or thread), as `audio/mp4` (`mimeType`) and temporary, since it lives in the outgoing cache (`isOwnCopy`); removing the chip deletes it. A recording shorter than 0.5 s is discarded as empty.

## Web

`apps/web/src/app.ts::record` uses the browser's MediaRecorder format, with its actual MIME type and a matching WebM, Ogg or MP4 filename. GTK's recording bar replaces the composer while capture runs: dot, elapsed time updated every 250 ms, Cancel and the native stop icon/label. Stopping stages the audio rather than sending it; cancel ends the actual capture tracks and stages nothing. The recording's stop control survives upload/live refreshes; a delayed microphone permission result is discarded after the originating room, account or membership changes. Withdrawal stops capture. The advanced browser suite injects a real incoming message during recording, checks cancel and capture shutdown, then records, replays the staged clip inline, uploads and plays the resulting protected audio. Browser codec support differs from the native recording pipelines.

## Why the formats differ

GTK uses Ogg/Opus, which "Rocket.Chat's web and mobile clients both play" (`recorder.rs`). SwiftUI uses AAC `.m4a`, "as the Android app sends them", since AVFoundation records AAC natively.

## Parity

Recording, replay and caption before sending, and sending exist in all three: the recording is staged like a file and leaves with the send button, in the room or a thread, encrypted RocketVibe rooms included. SwiftUI checked by the macOS CI build only.

## Sources

- apps/web/src/app.ts
- apps/web/src/audio.ts
- apps/web/tests/features.mjs

- apps/mobile/ui/composer.tsx
- apps/mobile/ui/attachmentPreview.tsx
- apps/mobile/ui/stagedAttachments.tsx
- apps/mobile/ui/audioPlayer.tsx
- apps/mobile/app/thread/[id].tsx
- apps/desktop/crates/rv-gtk/src/recorder.rs
- apps/desktop/crates/rv-gtk/src/composer.rs
- apps/desktop/crates/rv-gtk/src/chat.rs
- apps/desktop/crates/rv-gtk/src/thread.rs
- apps/desktop/crates/rv-gtk/src/cards.rs
- apps/desktop/crates/rv-core/src/session.rs
- apps/desktop/macos/Sources/RocketVibe/Composer.swift
- apps/desktop/macos/Sources/RocketVibe/ThreadView.swift
- apps/desktop/macos/Sources/RocketVibeKit/RoomModel.swift
