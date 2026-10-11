// Video reduction before sending, the main-thread side: feature detection for
// the pre-send preview and one worker per reduced video (video-reduce.worker.ts),
// terminated on cancel. Whatever happens short of a cancel, the answer is a
// file to send: the reduced MP4 or the original.
import { VIDEO_BITRATE, reducedName, videoReducible } from "./video-plan";
import type { ReduceAnswer } from "./video-reduce.worker";

let support: Promise<boolean> | undefined;

/**
 * Whether this browser can reduce videos: WebCodecs and an H.264 encoder at
 * 720p, the High profile Mediabunny asks for. Some Firefox builds and Linux
 * Chromium without a platform H.264 encoder answer no; their videos go out
 * in original quality, which the preview says.
 */
export function videoReductionSupported(): Promise<boolean> {
  support ??= (async () => {
    if (
      typeof Worker === "undefined" ||
      typeof VideoEncoder === "undefined" ||
      typeof VideoDecoder === "undefined"
    )
      return false;
    try {
      const answer = await VideoEncoder.isConfigSupported({
        codec: "avc1.64001f",
        width: 1280,
        height: 720,
        bitrate: VIDEO_BITRATE,
        framerate: 30,
      });
      return answer.supported === true;
    } catch {
      return false;
    }
  })();
  return support;
}

/** Why a video went out in original quality: for the console, not the user. */
const kept = (file: File, reason: string): File => {
  console.info("Video sent in original quality:", reason);
  return file;
};

/**
 * Reduces one video, reporting progress in [0, 1]. Resolves to the reduced
 * MP4 (the original's name, `.mp4`) or to the original file; rejects only
 * with an AbortError when `signal` fires, the worker being terminated.
 */
export async function reduceVideo(
  file: File,
  signal: AbortSignal,
  progress: (fraction: number) => void,
): Promise<File> {
  signal.throwIfAborted();
  if (!videoReducible(file)) return file;
  if (!(await videoReductionSupported())) return kept(file, "unsupported");
  signal.throwIfAborted();
  const worker = new Worker(
    new URL("./video-reduce.worker.ts", import.meta.url),
    { type: "module" },
  );
  try {
    return await new Promise<File>((resolve, reject) => {
      const abort = () =>
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      worker.onmessage = (event: MessageEvent<ReduceAnswer>) => {
        const answer = event.data;
        if (answer.type === "progress") {
          progress(answer.fraction);
          return;
        }
        signal.removeEventListener("abort", abort);
        if (answer.type === "reduced")
          resolve(
            new File([answer.buffer], reducedName(file.name), {
              type: "video/mp4",
            }),
          );
        else resolve(kept(file, answer.reason));
      };
      // A worker that cannot even load (CSP, an old browser) sends the original.
      worker.onerror = (event) => {
        event.preventDefault();
        signal.removeEventListener("abort", abort);
        resolve(kept(file, "worker-failed"));
      };
      worker.postMessage({ file });
    });
  } finally {
    worker.terminate();
  }
}
