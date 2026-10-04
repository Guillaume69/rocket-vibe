# Voice messages

A voice message is an audio file recorded from the microphone and sent through the ordinary upload queue, so it gets the same validation, dedup, retry and discard as any attachment ([uploads](uploads.md)). Nothing on the server marks it as "voice": it is an audio attachment that clients play in place. The apps differ in format and in whether the recording waits in the composer.

## Mobile

- **Recording** (`toggleVoice` in `ui/composer.tsx`): the 🎤 button asks the microphone permission (`expo-audio`), switches the audio session to allow recording (iOS refuses otherwise and would route playback to the earpiece afterwards), and records with the `HIGH_QUALITY` preset: AAC in `.m4a`, sent as `audio/mp4`. While recording, the button stays "stop" (⏹) even if text is typed, and 📎 is disabled.
- **Staged, not sent.** Stopping does not send: the recording becomes a staged piece named `vocal-<timestamp>.m4a`, shown above the field with a real player (`AudioPlayer` inside `ui/attachmentPreview.tsx`) so it can be replayed before sending. Text typed meanwhile becomes its caption, and ➤ sends it with any other staged files. Removing the chip deletes the recording from the cache.
- An empty recording (no URI) or a refused permission shows an error line above the composer.
- The thread composer has no 🎤 (it has no attachments, see [threads](threads.md)).
- **Playback** of any audio attachment, voice included, is `ui/audioPlayer.tsx`: play/pause, a seekable bar, and a frequency visualiser fed by an FFT of the output samples (Android's `Visualizer`, which needs `RECORD_AUDIO`; without it playback still works with idle bars). The player is only created on the first "play": mounting one per visible voice message buffered every file (about 20 MB for twenty messages scrolled past) and leaked the tokenised URL into ExoPlayer. One player plays at a time. Details in [media playback](media-playback.md).

## Desktop (GTK)

- **Recording** (`rv-gtk/src/recorder.rs`): a GStreamer pipeline `autoaudiosrc ! audioconvert ! audioresample ! opusenc bitrate=32000 ! oggmux ! filesink` writes Ogg/Opus to the user cache (`RV_AUDIO_SOURCE` can name another source, a test tone for the smoke tests). The composer swaps its field for a recording bar with the elapsed time, a cancel button and a send button, polling every 250 ms; a pipeline error (no microphone) stops the recording and shows a toast.
- **Finishing** sends end-of-stream through the muxer and waits up to 3 s for it, so the Ogg file is closed properly; a zero-byte file counts as empty ("voice.empty"). Cancelling deletes the file.
- **Sent at once.** The send button hands the file to `Chat` (`connect_voice` in `rv-gtk/src/chat.rs`), which calls `Session::attach` with `audio/ogg`, no caption, `temporary: true` (the file is deleted once uploaded). A refusal (for example a MIME whitelist without `audio/ogg`) shows "voice refused".
- Only the room's composer is wired: the thread page's composer shows the microphone, but no handler receives its recording, which is then deleted.
- **Playback**: audio file cards have a Play button that downloads to the cache, then plays with GTK's `MediaControls` over a GStreamer stream (`audio_player` in `rv-gtk/src/cards.rs`).

## Desktop (SwiftUI)

`VoiceRecorder` in `Composer.swift` records with `AVAudioRecorder` to AAC `.m4a` (44.1 kHz, mono, 64 kbps), after asking microphone access. The field row shows the elapsed time and a cancel button; the send button sends the recording at once as `audio/mp4`, no caption, temporary. A recording shorter than 0.5 s is discarded as empty.

## Why the formats differ

GTK uses Ogg/Opus, which "Rocket.Chat's web and mobile clients both play" (`recorder.rs`). SwiftUI uses AAC `.m4a`, "as the Android app sends them", since AVFoundation records AAC natively.

## Parity

Recording and sending exist in all three. Only mobile stages the recording for replay and caption before sending; desktop sends on the send button. None sends voice inside a thread: mobile's thread composer has no microphone, GTK's drops the recording, and SwiftUI's thread composer posts it to the room itself (`RoomModel.attach` passes no thread id).

## Sources

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
