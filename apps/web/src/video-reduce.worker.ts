/// <reference lib="webworker" />
// Re-encodes one staged video to H.264 MP4 at most 720p, off the main thread.
// Mediabunny (MPL-2.0, unmodified) demuxes the source (MP4, QuickTime, WebM,
// Matroska), drives the browser's WebCodecs decoders and encoders and muxes
// the MP4; it is only in this worker's chunk, fetched when a video is reduced.
// The answer is always usable: the reduced bytes, or "original" with a reason,
// never a failed send. Cancelling terminates the worker.
import {
  BufferTarget,
  BlobSource,
  Conversion,
  Input,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  Output,
  QTFF,
  WEBM,
  canEncodeAudio,
  canEncodeVideo,
} from "mediabunny";
import { keepReduced, reductionPlan } from "./video-plan";

declare const self: DedicatedWorkerGlobalScope;

export type ReduceRequest = { file: File };
export type ReduceAnswer =
  | { type: "progress"; fraction: number }
  | { type: "reduced"; buffer: ArrayBuffer }
  | { type: "original"; reason: string };

const post = (answer: ReduceAnswer, transfer: Transferable[] = []) =>
  self.postMessage(answer, transfer);

async function reduce(file: File): Promise<ArrayBuffer | string> {
  const input = new Input({
    source: new BlobSource(file),
    formats: [MP4, QTFF, WEBM, MATROSKA],
  });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) return "no-video-track";
    const plan = reductionPlan({
      width: video.displayWidth,
      height: video.displayHeight,
      duration: await input.computeDuration(),
      bytes: file.size,
    });
    if (!plan) return "already-small";
    if (
      !(await canEncodeVideo("avc", {
        width: plan.width,
        height: plan.height,
        bitrate: plan.bitrate,
      }))
    )
      return "no-h264-encoder";
    if (!(await video.canDecode())) return "undecodable-source";
    const format = new Mp4OutputFormat({ fastStart: "in-memory" });
    const output = new Output({ format, target: new BufferTarget() });
    const mp4Audio = format.getSupportedAudioCodecs();
    const conversion = await Conversion.init({
      input,
      output,
      tracks: "primary",
      showWarnings: false,
      video: {
        width: plan.width,
        height: plan.height,
        fit: "fill",
        codec: "avc",
        bitrate: plan.bitrate,
        forceTranscode: true,
      },
      // As on mobile: the sound is copied when MP4 can carry it, otherwise
      // re-encoded, to AAC where the browser has an encoder.
      audio: async (track) => {
        if (track.codec && mp4Audio.includes(track.codec)) return {};
        if (
          await canEncodeAudio("aac", {
            numberOfChannels: track.numberOfChannels,
            sampleRate: track.sampleRate,
          })
        )
          return { codec: "aac" };
        return {};
      },
    });
    // A video without its sound is not the video the user picked.
    if (!conversion.isValid || conversion.discardedTracks.length)
      return "unsupported-track";
    let last = 0;
    conversion.onProgress = (fraction) => {
      if (fraction - last < 0.01 && fraction < 1) return;
      last = fraction;
      post({ type: "progress", fraction });
    };
    await conversion.execute();
    const buffer = output.target.buffer;
    if (!buffer || !keepReduced(file.size, buffer.byteLength))
      return "not-lighter";
    return buffer;
  } finally {
    input.dispose();
  }
}

self.onmessage = async (event: MessageEvent<ReduceRequest>) => {
  try {
    const result = await reduce(event.data.file);
    if (typeof result === "string") post({ type: "original", reason: result });
    else post({ type: "reduced", buffer: result }, [result]);
  } catch (error) {
    post({
      type: "original",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
};
