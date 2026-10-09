import type {
  Track,
  TrackProcessor,
  AudioProcessorOptions,
} from "livekit-client";
export interface SharedVoice {
  sid: string;
  track: MediaStreamTrack;
  volume: number;
}
// Capture sound stays separate from the call. Remote voices are only mixed
// when the native include-call preference is enabled.
export class ShareAudioMixer implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  name = "RocketVibe shared sound";
  processedTrack?: MediaStreamTrack;
  context?: AudioContext;
  destination?: MediaStreamAudioDestinationNode;
  base?: MediaStreamAudioSourceNode;
  voices: SharedVoice[] = [];
  nodes = new Map<
    string,
    {
      track: MediaStreamTrack;
      source: MediaStreamAudioSourceNode;
      gain: GainNode;
    }
  >();
  async init(options: AudioProcessorOptions): Promise<void> {
    this.context = options.audioContext;
    this.destination = this.context.createMediaStreamDestination();
    this.base = this.context.createMediaStreamSource(
      new MediaStream([options.track]),
    );
    this.base.connect(this.destination);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
    this.sync(this.voices);
  }
  sync(voices: SharedVoice[]): void {
    this.voices = voices;
    if (!this.context || !this.destination) return;
    const wanted = new Set(voices.map((voice) => voice.sid));
    for (const [sid, node] of this.nodes)
      if (!wanted.has(sid)) {
        node.source.disconnect();
        node.gain.disconnect();
        this.nodes.delete(sid);
      }
    for (const voice of voices) {
      let node = this.nodes.get(voice.sid);
      if (node && node.track !== voice.track) {
        node.source.disconnect();
        node.gain.disconnect();
        this.nodes.delete(voice.sid);
        node = undefined;
      }
      if (!node) {
        const source = this.context.createMediaStreamSource(
            new MediaStream([voice.track]),
          ),
          gain = this.context.createGain();
        source.connect(gain).connect(this.destination);
        node = { source, gain, track: voice.track };
        this.nodes.set(voice.sid, node);
      }
      node.gain.gain.value = voice.volume;
    }
  }
  async restart(options: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(options);
  }
  async destroy(): Promise<void> {
    this.base?.disconnect();
    this.base = undefined;
    for (const node of this.nodes.values()) {
      node.source.disconnect();
      node.gain.disconnect();
    }
    this.nodes.clear();
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    this.destination = undefined;
    this.context = undefined;
  }
}
export function excludesOwnAudio(track: MediaStreamTrack): boolean {
  return (
    (track.getSettings() as MediaTrackSettings & { restrictOwnAudio?: boolean })
      .restrictOwnAudio === true
  );
}
