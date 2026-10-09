// Same level scale, thresholds and hangover as desktop/voice/src/audio.rs.
export const LOCAL_SPEECH_DB = -50;
export const REMOTE_SPEECH_DB = -52;
export class VoiceActivity {
  level = 0;
  heard = -Infinity;
  sampled?: number;
  update(rms: number, threshold: number, now: number): void {
    const db = Number.isFinite(rms) && rms > 0 ? 20 * Math.log10(rms) : -100;
    const level = Math.max(0, Math.min(1, (db + 60) / 60));
    const decay = Math.pow(
      0.8,
      Math.max(1, (now - (this.sampled ?? now - 10)) / 10),
    );
    this.level =
      level > this.level ? level : this.level * decay + level * (1 - decay);
    this.sampled = now;
    if (db > threshold) this.heard = now;
  }
  speaking(now: number): boolean {
    return now - this.heard < 350;
  }
  quiet(): void {
    this.level = 0;
    this.heard = -Infinity;
    this.sampled = undefined;
  }
}
