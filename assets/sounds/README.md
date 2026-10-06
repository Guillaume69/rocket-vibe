# Voice sounds

Original sounds of the voice feature, synthesized from code by
`scripts/sounds/generate.mjs` (no sample, no third-party recording) and encoded
by `scripts/sounds/encode.sh`. Regenerate them rather than editing the files.

| File | Use |
|---|---|
| `ringtone.ogg` | Incoming direct call, looped ("Neon Drive", synthwave). |
| `ringback.ogg` | The caller hears it while the call rings, looped. |
| `cue-join.ogg`, `cue-leave.ogg` | Someone joins or leaves the voice session you are in. |
| `cue-mute.ogg`, `cue-unmute.ogg` | Your microphone or sound is cut or restored. |
| `cue-missed.ogg` | A call was missed or declined. |
