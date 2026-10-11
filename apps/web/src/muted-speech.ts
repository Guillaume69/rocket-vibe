// Matches rv_voice_protocol::MutedSpeechReminder; all detection is local.
export class MutedSpeechReminder {
  private began?: number;
  private warned = false;
  private last = -Infinity;
  update(muted: boolean, speaking: boolean, now: number): boolean {
    if (!muted || !speaking) {
      this.began = undefined;
      this.warned = false;
      return false;
    }
    this.began ??= now;
    if (!this.warned && now - this.began >= 600 && now - this.last >= 10_000) {
      this.warned = true;
      this.last = now;
      return true;
    }
    return false;
  }
}
/** Unpublished capture with no connection to a speaker or RTP sender. */
export class MutedMicrophoneMonitor {
  private generation = 0;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private analyser?: AnalyserNode;
  private samples = new Float32Array(512);
  private device?: string;
  async start(
    context: AudioContext,
    device: string,
    valid: () => boolean,
  ): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.device = device;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: device === "default" ? undefined : { exact: device },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (
        generation !== this.generation ||
        !valid() ||
        context.state === "closed"
      ) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.source = context.createMediaStreamSource(stream);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 512;
      this.source.connect(this.analyser);
    } catch {
      // Missing permission or device must leave the call muted.
      if (generation === this.generation) {
        this.stop();
        this.device = device;
      }
    }
  }
  uses(device: string): boolean {
    return this.device === device;
  }
  rms(): number {
    if (
      !this.analyser ||
      !this.stream
        ?.getAudioTracks()
        .some((track) => track.readyState === "live")
    )
      return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    return Math.sqrt(
      this.samples.reduce((sum, sample) => sum + sample * sample, 0) /
        this.samples.length,
    );
  }
  stop(): void {
    this.generation++;
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.source = undefined;
    this.analyser = undefined;
    this.stream = undefined;
    this.device = undefined;
  }
}
