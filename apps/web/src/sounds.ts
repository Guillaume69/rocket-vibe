import ringtone from "../../../assets/sounds/ringtone.ogg";
import ringback from "../../../assets/sounds/ringback.ogg";
import join from "../../../assets/sounds/cue-join.ogg";
import leave from "../../../assets/sounds/cue-leave.ogg";
import mute from "../../../assets/sounds/cue-mute.ogg";
import unmute from "../../../assets/sounds/cue-unmute.ogg";
import missed from "../../../assets/sounds/cue-missed.ogg";
const sources = { ringtone, ringback, join, leave, mute, unmute, missed };
export function sound(
  name: keyof typeof sources,
  loop = false,
): HTMLAudioElement {
  const audio = new Audio(sources[name]);
  audio.loop = loop;
  audio.volume = 0.5;
  void audio.play().catch(() => {});
  return audio;
}
