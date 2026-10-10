import { useLayoutEffect, useRef } from "react";
import type { App } from "../app";
import { composer } from "../composer";
import { toast } from "../dom";
import { t } from "../i18n";
import { IconButton } from "./controls";
import { renderView } from "./portals";

export interface ThreadOptions {
  draft: string;
  disabled?: boolean;
  send(text: string): Promise<void>;
  save(text: string): void;
  older(): void;
  files?: (files: File[]) => void;
}
function ThreadView({ app, options }: { app: App; options: ThreadOptions }) {
  const timeline = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const files = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    app.threadTimeline = timeline.current!;
    const input = composer(editor.current!);
    app.threadComposer = input;
    input.placeholder = t("message");
    input.setAttribute("aria-label", t("thread"));
    input.value = options.draft;
    input.disabled = !!options.disabled;
    const abort = new AbortController();
    input.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          void options.send(input.value).catch(toast);
        }
      },
      { signal: abort.signal },
    );
    input.addEventListener("input", () => options.save(input.value), {
      signal: abort.signal,
    });
    return () => {
      abort.abort();
      input.dispose();
    };
  }, [app, options]);
  return (
    <>
      <header className="headerbar">
        <span className="room-title">{t("thread")}</span>
        <IconButton
          name="close"
          label={t("close")}
          action={() => app.closeThread()}
        />
      </header>
      <div
        ref={timeline}
        className="timeline"
        onScroll={() => {
          if (timeline.current!.scrollTop < 100) options.older();
          void app.markThread();
        }}
      />
      <div className="composer">
        {options.files && (
          <input
            ref={files}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              options.files!(Array.from(event.currentTarget.files || []));
              event.currentTarget.value = "";
            }}
          />
        )}
        <IconButton
          name="attach"
          label={t("attach")}
          action={() => {
            if (options.files) files.current?.click();
            else app.pickFile();
          }}
        />
        <div ref={editor} className="composer-input rich-composer" />
        <IconButton name="mic" label={t("voice")} action={() => app.record()} />
        <IconButton
          name="send"
          label={t("send")}
          className="send"
          action={() => options.send(app.threadComposer.value)}
        />
      </div>
    </>
  );
}
export function showThread(app: App, options: ThreadOptions): void {
  app.threadPane.hidden = false;
  renderView(app.threadPane, <ThreadView app={app} options={options} />);
}
