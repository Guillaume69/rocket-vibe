import { dialog, el, button } from "./dom";
import { nt } from "./native-i18n";
export interface ShareQuality {
  height: number;
  fps: number;
}
export function savedQuality(): ShareQuality {
  const height = Number(localStorage.getItem("rv-share-height")),
    fps = Number(localStorage.getItem("rv-share-fps"));
  return {
    height: [720, 1080, 1440].includes(height) ? height : 1080,
    fps: [15, 30, 60].includes(fps) ? fps : 15,
  };
}
export function chooseShareQuality(
  signal: AbortSignal,
): Promise<ShareQuality | undefined> {
  const [node, body] = dialog(nt("voice_share.title"));
  node.classList.add("voice-share-dialog");
  node.setAttribute("aria-label", nt("voice_share.title"));
  body.classList.add("voice-share-body");
  body.append(el("div", "voice-share-portal", nt("voice_share.portal")));
  const footer = el("div", "voice-share-footer"),
    quality = savedQuality();
  const option = (
    key: string,
    choices: number[],
    value: number,
    suffix = "",
  ) => {
    const row = el("label", "voice-share-choice"),
      select = el("select", "row-select");
    select.setAttribute("aria-label", nt(key));
    for (const choice of choices) {
      const entry = el("option", "", String(choice) + suffix);
      entry.value = String(choice);
      select.append(entry);
    }
    select.value = String(value);
    row.append(el("span", "", nt(key)), select);
    footer.append(row);
    return select;
  };
  const height = option(
      "voice_share.resolution",
      [720, 1080, 1440],
      quality.height,
      "p",
    ),
    fps = option("voice_share.fps", [15, 30, 60], quality.fps);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value?: ShareQuality) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => {
      finish();
      node.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    node.addEventListener("close", () => finish(), { once: true });
    footer.append(
      button(
        nt("voice_share.start"),
        () => {
          const selected = {
            height: Number(height.value),
            fps: Number(fps.value),
          };
          localStorage.setItem("rv-share-height", String(selected.height));
          localStorage.setItem("rv-share-fps", String(selected.fps));
          finish(selected);
          node.close();
        },
        "suggested-action pill",
      ),
    );
    body.append(footer);
    if (signal.aborted) abort();
  });
}
