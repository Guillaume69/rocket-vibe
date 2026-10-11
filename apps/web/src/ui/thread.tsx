import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { App } from "../app";
import { composer } from "../composer";
import { toast } from "../dom";
import { t } from "../i18n";
import { IconButton } from "./controls";
import { renderView } from "./portals";

export interface ThreadOptions {
  draft: string;
  disabled?: boolean;
  /** The root's id, for the follow button. */
  root?: string;
  /** The server can follow threads (`thread_follow`). */
  follow?: boolean;
  /** The server can show a reply in the room too (`thread_also_in_room`). */
  alsoInRoom?: boolean;
  send(text: string, alsoInRoom?: boolean): Promise<void>;
  save(text: string): void;
  older(): void;
  files?: (files: File[]) => void;
}
function ThreadView({ app, options }: { app: App; options: ThreadOptions }) {
  const timeline = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const shown = useRef<HTMLInputElement>(null);
  // One reply at a time: the box clears once that reply is queued.
  const send = async (text: string) => {
    const also = !!shown.current?.checked;
    await options.send(text, also);
    if (shown.current) shown.current.checked = false;
  };
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
          void send(input.value).catch(toast);
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
        {options.follow && options.root && (
          <FollowButton app={app} root={options.root} />
        )}
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
      {options.alsoInRoom && !options.disabled && (
        <label className="also-in-room">
          <input ref={shown} type="checkbox" />
          <span>{t("alsoInRoom")}</span>
        </label>
      )}
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
        {app.canSchedule() && app.root && (
          <IconButton
            name="up"
            label={t("sendLater")}
            className="send-later"
            action={(node) => app.sendLater(node, app.root)}
          />
        )}
        <IconButton
          name="send"
          label={t("send")}
          className="send"
          action={() => send(app.threadComposer.value)}
        />
      </div>
    </>
  );
}
/** Follow / Unfollow for the open thread, kept in step with the model. */
function FollowButton({ app, root }: { app: App; root: string }) {
  const read = () => {
    const message = app.model.messages.get(root);
    return message ? app.following(message) : false;
  };
  const [following, setFollowing] = useState(read);
  useEffect(() => {
    const update = () => setFollowing(read());
    update();
    window.addEventListener("rv-model-update", update);
    return () => window.removeEventListener("rv-model-update", update);
  });
  return (
    <IconButton
      name="follow"
      label={t(following ? "unfollowThread" : "followThread")}
      className={"flat thread-follow" + (following ? " following" : "")}
      aria-pressed={following}
      action={async () => {
        const message = await app.followThread(root, !following);
        setFollowing(app.following(message));
      }}
    />
  );
}
export function showThread(app: App, options: ThreadOptions): void {
  app.threadPane.hidden = false;
  renderView(app.threadPane, <ThreadView app={app} options={options} />);
}
