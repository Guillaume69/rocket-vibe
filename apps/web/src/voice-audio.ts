import type { TrackProcessor, AudioProcessorOptions } from "livekit-client";
import type { Track } from "livekit-client";
export class MicrophoneGain implements TrackProcessor<
  Track.Kind.Audio,
  AudioProcessorOptions
> {
  name = "RocketVibe microphone level";
  processedTrack?: MediaStreamTrack;
  gain?: GainNode;
  analyser?: AnalyserNode;
  source?: MediaStreamAudioSourceNode;
  destination?: MediaStreamAudioDestinationNode;
  volume: number;
  constructor(volume = 1) {
    this.volume = volume;
  }
  async init(options: AudioProcessorOptions): Promise<void> {
    const context = options.audioContext;
    this.source = context.createMediaStreamSource(
      new MediaStream([options.track]),
    );
    this.gain = context.createGain();
    this.gain.gain.value = this.volume;
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 256;
    this.destination = context.createMediaStreamDestination();
    this.source
      .connect(this.gain)
      .connect(this.analyser)
      .connect(this.destination);
    this.processedTrack = this.destination.stream.getAudioTracks()[0];
  }
  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(2, value));
    if (this.gain) this.gain.gain.value = this.volume;
  }
  level(): number {
    if (!this.analyser) return 0;
    const buffer = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buffer);
    return Math.min(
      1,
      Math.sqrt(
        buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length,
      ),
    );
  }
  async restart(options: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(options);
  }
  async destroy(): Promise<void> {
    this.source?.disconnect();
    this.gain?.disconnect();
    this.analyser?.disconnect();
    this.processedTrack?.stop();
    this.source = undefined;
    this.gain = undefined;
    this.analyser = undefined;
    this.destination = undefined;
    this.processedTrack = undefined;
  }
}
export function volumeValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(2, value))
    : 1;
}
