// The pure half of video reduction before sending, tested under Node: WHEN a
// staged video is re-encoded and to WHAT. The effects (demux, WebCodecs
// re-encode, MP4 mux) live in video-reduce.worker.ts. The figures are the
// mobile app's (apps/mobile/ui/prepareAttachment.ts): H.264 MP4, short side
// capped at 720 pixels with the aspect kept, 2 Mbps.

/** Maximum short side of a reduced video, in pixels (720p). */
export const VIDEO_MAX_SHORT_SIDE = 720;
/** Video bitrate of the re-encode, the mobile app's. */
export const VIDEO_BITRATE = 2_000_000;
/** Floor of the re-encode bitrate: below it 720p turns to mush. */
export const VIDEO_MIN_BITRATE = 500_000;
/**
 * A source already within 720p whose average bitrate stays under this is not
 * re-encoded: the output could not be meaningfully lighter.
 */
export const VIDEO_KEEP_BITRATE = Math.round(VIDEO_BITRATE * 1.1);

/** What the demuxer tells about a source: upright (display) size, length. */
export type VideoSource = {
  /** Display width, rotation applied. */
  width: number;
  /** Display height, rotation applied. */
  height: number;
  /** Duration in seconds; 0 or less when unknown. */
  duration: number;
  /** Size of the file, in bytes. */
  bytes: number;
};
export type VideoPlan = { width: number; height: number; bitrate: number };

/** Every video is a candidate, as on mobile; the plan decides the rest. */
export function videoReducible(file: { type: string; size: number }): boolean {
  return file.type.startsWith("video/") && file.size > 0;
}

const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

/**
 * Output size: the short side capped at 720, the long side following the
 * aspect, both even (an H.264 4:2:0 encoder constraint). A portrait and a
 * landscape video come out with the same short side.
 */
export function targetDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const short = Math.min(width, height);
  if (short <= VIDEO_MAX_SHORT_SIDE)
    return { width: even(width), height: even(height) };
  const scale = VIDEO_MAX_SHORT_SIDE / short;
  return width <= height
    ? { width: VIDEO_MAX_SHORT_SIDE, height: even(height * scale) }
    : { width: even(width * scale), height: VIDEO_MAX_SHORT_SIDE };
}

/** Average bitrate of the whole file (sound included), Infinity if unknown. */
export function averageBitrate(
  source: Pick<VideoSource, "duration" | "bytes">,
): number {
  return source.duration > 0 ? (source.bytes * 8) / source.duration : Infinity;
}

/**
 * The re-encode, or null when it cannot pay off: a source within 720p whose
 * average bitrate is already about the target's. The bitrate never exceeds
 * the source's own average: a low-bitrate 1080p re-encoded at 2 Mbps would
 * come out heavier.
 */
export function reductionPlan(source: VideoSource): VideoPlan | null {
  if (
    !(source.width > 0 && source.height > 0) ||
    !Number.isFinite(source.width) ||
    !Number.isFinite(source.height)
  )
    return null;
  const resized = Math.min(source.width, source.height) > VIDEO_MAX_SHORT_SIDE;
  const average = averageBitrate(source);
  if (!resized && average <= VIDEO_KEEP_BITRATE) return null;
  return {
    ...targetDimensions(source.width, source.height),
    bitrate: Math.max(
      VIDEO_MIN_BITRATE,
      Math.min(VIDEO_BITRATE, Math.round(average)),
    ),
  };
}

/** The mobile safeguard: a re-encode that is not lighter is thrown away. */
export function keepReduced(
  originalBytes: number,
  reducedBytes: number,
): boolean {
  return reducedBytes > 0 && reducedBytes < originalBytes;
}

/** The reduced file keeps the original's name, with the `.mp4` extension. */
export function reducedName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, "");
  return (base || "video") + ".mp4";
}
