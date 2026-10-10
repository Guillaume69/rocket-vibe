import {
  Fragment,
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  FileDescriptor,
  LinkPreview,
  Message,
  Node as MarkdownNode,
} from "../protocol";
import type { RowActions } from "../render";
import { safeLink } from "./links";
import { t, language } from "../i18n";
import { nt } from "../native-i18n";
import { systemText } from "../presentation";
import { emojiGlyph } from "../emoji";
import { humanSize } from "../media-format";
import { inlineImage } from "../image-attachment";
import { videoLink, videoLinks } from "../video-links";
import { stopMedia } from "../dom";
import { operation, segment } from "../api";
import { ActionButton, Avatar, IconButton, Symbol } from "./controls";
import { useApp } from "./context";
import { elementView, renderView } from "./portals";

export function Emoji({ code }: { code: string }) {
  const app = useApp();
  const custom = app.emojis.get(code);
  const generation = app.generation;
  const [image, setImage] = useState<{
    code: string;
    generation: number;
    url: string;
  }>();
  useEffect(() => {
    let active = true;
    if (!custom) return;
    void app
      .asset("/api/v1/emoji/files/" + segment(custom.file_id), custom.sha256)
      .then((url) => {
        if (active && generation === app.generation)
          setImage({ code, generation, url });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [app, code, custom?.file_id, custom?.sha256, generation]);
  return (
    <span className="emoji">
      {custom && image?.code === code && image.generation === generation ? (
        <img
          className="custom-emoji"
          src={image.url}
          alt={":" + code + ":"}
          title={":" + code + ":"}
        />
      ) : (
        emojiGlyph(code)
      )}
    </span>
  );
}

function Mention({ name }: { name: string }) {
  const app = useApp();
  const mine =
    name === app.account?.session.user.username ||
    name === "all" ||
    name === "here";
  return (
    <span className={"mention" + (mine ? " mention-me" : "")}>@{name}</span>
  );
}

export function Markdown({
  nodes,
  depth = 0,
}: {
  nodes: MarkdownNode[];
  depth?: number;
}) {
  if (depth > 32) return null;
  return nodes.map((item, index) => {
    const children =
      "children" in item ? (
        <Markdown nodes={item.children} depth={depth + 1} />
      ) : undefined;
    let content;
    switch (item.kind) {
      case "text":
        content = item.text;
        break;
      case "break":
        content = <br />;
        break;
      case "rule":
        content = <hr />;
        break;
      case "mention":
        content = <Mention name={item.name} />;
        break;
      case "room_mention":
        content = <span className="mention">#{item.name}</span>;
        break;
      case "emoji":
        content = <Emoji code={item.shortcode} />;
        break;
      case "inline_code":
        content = <code>{item.text}</code>;
        break;
      case "code_block":
        content = (
          <pre className="md-code">
            <code>{item.text}</code>
          </pre>
        );
        break;
      case "heading":
        content = createElement(
          "h" + Math.max(1, Math.min(4, item.level)),
          { className: "md-h" + item.level },
          children,
        );
        break;
      case "bold":
        content = <strong>{children}</strong>;
        break;
      case "italic":
        content = <em>{children}</em>;
        break;
      case "strike":
        content = <s>{children}</s>;
        break;
      case "quote":
        content = <blockquote className="md-quote">{children}</blockquote>;
        break;
      case "list":
        content = item.start ? (
          <ol start={item.start}>{children}</ol>
        ) : (
          <ul>{children}</ul>
        );
        break;
      case "list_item":
        content = (
          <li>
            {item.checked != null && <span>{item.checked ? "☑ " : "☐ "}</span>}
            {children}
          </li>
        );
        break;
      case "link": {
        const href = safeLink(item.href);
        content = href ? (
          <a href={href} rel="noopener noreferrer" target="_blank">
            {children}
          </a>
        ) : (
          children
        );
        break;
      }
      default:
        content = <p>{children}</p>;
    }
    return <Fragment key={index}>{content}</Fragment>;
  });
}

function PlayBadge() {
  return (
    <span className="media-play-badge">
      <svg viewBox="0 0 60 60" aria-hidden="true">
        <circle cx="30" cy="30" r="30" fill="#000" fillOpacity=".55" />
        <path d="M21.6 18 43.2 30 21.6 42Z" fill="#fff" />
      </svg>
    </span>
  );
}

function FileAttachment({
  file,
  actions,
}: {
  file: FileDescriptor;
  actions: RowActions;
}) {
  const card = useRef<HTMLDivElement>(null);
  const image = inlineImage(
    actions.privateFiles ? { ...file, encrypted: false } : file,
  );
  const video =
    file.media_type.startsWith("video/") &&
    (!file.encrypted || actions.privateFiles);
  const playable =
    file.media_type.startsWith("audio/") ||
    file.media_type.startsWith("video/");
  const [status, setStatus] = useState<string>();
  useEffect(() => {
    const node = card.current!;
    if (
      (image && Number(file.bytes) < 10 * 1024 * 1024) ||
      (video && Number(file.bytes) <= 25 * 1024 * 1024)
    )
      void actions.file(file, node).catch(() => {
        if (video && node.isConnected) setStatus(nt("file.failed"));
      });
    const ready = (event: Event) => {
      const player = event.target;
      if (player instanceof HTMLMediaElement)
        setStatus(
          humanSize(player.dataset.bytes || file.bytes) +
            " · " +
            (player.dataset.mediaType || file.media_type),
        );
    };
    node.addEventListener("loadeddata", ready, true);
    return () => {
      node.removeEventListener("loadeddata", ready, true);
      stopMedia(node);
    };
  }, [
    file.id,
    file.sha256,
    file.media_type,
    file.encrypted,
    actions,
    image,
    video,
  ]);
  const load = () => actions.file(file, card.current!);
  const download = async () => {
    await load();
    card.current?.querySelector<HTMLAnchorElement>(".file-download")?.click();
  };
  if (image)
    return (
      <div
        ref={card}
        className="image-card"
        data-file-id={file.id}
        data-file-hash={file.sha256}
      >
        {file.filename && (
          <span className="attachment-title">{file.filename}</span>
        )}
        <ActionButton
          className="image-frame"
          aria-label={file.filename || nt("message.image")}
          title={file.filename || ""}
          action={async (frame) => {
            await load();
            if (frame.isConnected)
              frame.dispatchEvent(new Event("rv-image-open"));
          }}
        />
      </div>
    );
  if (video)
    return (
      <div
        ref={card}
        className="video-card video-attachment"
        data-file-id={file.id}
        data-file-hash={file.sha256}
      >
        <div className="video-frame">
          <ActionButton
            className="video-play-trigger"
            aria-label={nt("file.play")}
            action={async () => {
              const player = card.current?.querySelector("video");
              if (player) {
                if (player.paused) await player.play();
                else player.pause();
                return;
              }
              setStatus(nt("file.loading"));
              try {
                await load();
                if (card.current?.isConnected)
                  await card.current.querySelector("video")?.play();
              } catch (error) {
                setStatus(nt("file.failed"));
                throw error;
              }
            }}
          >
            <PlayBadge />
          </ActionButton>
        </div>
        <div className="file-top video-caption">
          <div className="file-names">
            <div className="file-title">{file.filename || file.media_type}</div>
            <div className="file-detail">
              {status || humanSize(file.bytes) + " · " + file.media_type}
            </div>
          </div>
          <IconButton
            name="open-file"
            label={nt("video.open_elsewhere")}
            className="flat file-download-trigger"
            action={download}
          />
        </div>
      </div>
    );
  return (
    <div
      ref={card}
      className="file-card"
      data-file-id={file.id}
      data-file-hash={file.sha256}
    >
      <div className="file-top">
        <span className="file-icon">
          <Symbol
            name={
              file.media_type.startsWith("audio/") ? "audio-file" : "text-file"
            }
          />
        </span>
        <div className="file-names">
          <div className="file-title">{file.filename || file.media_type}</div>
          <div className="file-detail">
            {humanSize(file.bytes) + " · " + file.media_type}
          </div>
        </div>
        <IconButton
          name="download"
          label={t("download")}
          className="file-download-trigger"
          action={download}
        />
        {playable ? (
          <ActionButton
            className="file-play-trigger file-action"
            action={async () => {
              await load();
              await card.current
                ?.querySelector<HTMLMediaElement>("audio,video")
                ?.play();
            }}
          >
            {language === "fr" ? "Lire" : "Play"}
          </ActionButton>
        ) : (
          <ActionButton className="file-action" action={download}>
            {nt("file.open")}
          </ActionButton>
        )}
      </div>
    </div>
  );
}

function VideoSite({
  message,
  preview,
  href,
  actions,
}: {
  message: Message;
  preview?: LinkPreview;
  href: string;
  actions: RowActions;
}) {
  const video = videoLink(href)!;
  const thumbnail = useRef<HTMLButtonElement>(null);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const node = thumbnail.current;
    if (
      node &&
      preview?.image &&
      BigInt(preview.image.bytes) < 10n * 1024n * 1024n
    )
      void actions.previewImage(message, preview.image, node).catch(() => {});
  }, [message.id, preview?.image?.sha256, actions]);
  const source = new URL(video.embed);
  source.searchParams.set("autoplay", "1");
  return (
    <div
      className={"link-card embedded-video" + (playing ? " playing" : "")}
      data-video-url={video.url}
      data-video-key={video.provider + ":" + video.id}
    >
      <div className="video-site-top">
        <a
          className="video-heading"
          href={video.url}
          target="_blank"
          rel="noopener noreferrer"
          title={video.url}
        >
          <div className="link-site">{video.provider}</div>
          {preview?.title && <div className="link-title">{preview.title}</div>}
          {preview?.site && (
            <div className="link-description">{preview.site}</div>
          )}
        </a>
        <IconButton
          name="close"
          label={nt("player.stop")}
          className="flat video-site-stop"
          hidden={!playing}
          action={() => setPlaying(false)}
        />
      </div>
      <ActionButton
        ref={thumbnail}
        className="video-thumb preview-image"
        aria-label={nt("file.play") + " " + video.provider}
        hidden={playing}
        action={() => setPlaying(true)}
      >
        <PlayBadge />
      </ActionButton>
      {playing && (
        <iframe
          className="video-player"
          src={source.href}
          title={preview?.title || video.provider}
          referrerPolicy="strict-origin-when-cross-origin"
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
        />
      )}
    </div>
  );
}

function PreviewCard({
  message,
  preview,
  actions,
}: {
  message: Message;
  preview: LinkPreview;
  actions: RowActions;
}) {
  const card = useRef<HTMLAnchorElement>(null);
  const href = safeLink(preview.url);
  useEffect(() => {
    if (
      card.current &&
      preview.image &&
      BigInt(preview.image.bytes) < 10n * 1024n * 1024n
    )
      void actions
        .previewImage(message, preview.image, card.current)
        .catch(() => {});
  }, [message.id, preview.image?.sha256, actions]);
  return href ? (
    <a
      ref={card}
      className="link-card"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <div className="link-title">{preview.title || preview.url}</div>
      <div className="link-description">{preview.description || ""}</div>
    </a>
  ) : null;
}

function documentLinks(nodes: MarkdownNode[], depth = 0): string[] {
  if (depth > 32) return [];
  return nodes.flatMap((node) =>
    node.kind === "link"
      ? [node.href, ...documentLinks(node.children, depth + 1)]
      : "children" in node
        ? documentLinks(node.children, depth + 1)
        : [],
  );
}

function WorkflowCard({
  message,
  mine,
  actions,
}: {
  message: Message;
  mine: string;
  actions: RowActions;
}) {
  const form = message.form!;
  return (
    <div className="card workflow-form-card">
      <strong className="workflow-form-title">{form.title}</strong>
      <span className="dim">
        {form.recipient
          ? nt("workflows.form_for", { user: form.recipient.username })
          : nt("workflows.form_anyone")}
      </span>
      {form.answered_by ? (
        <span className="workflow-form-answered">
          {nt("workflows.form_answered_by", {
            name: form.answered_by.display_name || form.answered_by.username,
          })}
        </span>
      ) : new Date(form.expires_at).getTime() <= Date.now() ? (
        <span className="dim">{nt("workflows.form_expired")}</span>
      ) : (
        (!form.recipient || form.recipient.id === mine) && (
          <ActionButton
            className="cta workflow-form-answer"
            action={() => actions.answerForm(message)}
          >
            {nt("workflows.form_answer")}
          </ActionButton>
        )
      )}
    </div>
  );
}

export interface EditRequest {
  revision: string;
}
function InlineEditor({
  message,
  revision,
  actions,
  close,
}: {
  message: Message;
  revision: string;
  actions: RowActions;
  close: () => void;
}) {
  const [text, setText] = useState(message.text);
  const [id] = useState(operation);
  return (
    <div className="edit-field">
      <textarea
        className="composer-input"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        autoFocus
      />
      <ActionButton className="edit-button" action={close}>
        {t("cancel")}
      </ActionButton>
      <ActionButton
        className="edit-button save"
        action={async () => {
          if (!actions.updateMessage) return;
          await actions.updateMessage(message, revision, text, id);
          close();
        }}
      >
        {t("save")}
      </ActionButton>
    </div>
  );
}

export function MessageView({
  message,
  mine,
  actions,
  grouped = false,
  host,
}: {
  message: Message;
  mine: string;
  actions: RowActions;
  grouped?: boolean;
  host?: HTMLElement;
}) {
  const app = useApp();
  const row = useRef<HTMLElement>(null);
  const [editing, setEditing] = useState<EditRequest>();
  useLayoutEffect(() => {
    const node = host || row.current!;
    const edit = (event: Event) =>
      setEditing((event as CustomEvent<EditRequest>).detail);
    node.addEventListener("rv-edit-message", edit);
    return () => node.removeEventListener("rv-edit-message", edit);
  }, [message.id, host]);
  useLayoutEffect(() => {
    if (host) {
      if (editing) host.dataset.editing = "true";
      else delete host.dataset.editing;
    }
  }, [host, editing]);
  const time = new Date(message.created_at).toLocaleTimeString(language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (message.system)
    return host ? (
      systemText(message)
    ) : (
      <article
        ref={row}
        className="system-message message-system"
        data-id={message.id}
        data-stamp={JSON.stringify(message)}
      >
        {systemText(message)}
      </article>
    );
  const videos = new Map<string, ReturnType<typeof videoLink>>();
  for (const href of [
    ...documentLinks(message.body?.nodes || []),
    ...videoLinks(message.text).map((video) => video.url),
  ]) {
    const video = videoLink(href);
    if (video && videos.size < 3) videos.set(video.url, video);
  }
  const content = (
    <>
      <div className="message-gutter">
        {grouped ? (
          <span className="gutter-time">{time}</span>
        ) : (
          <ActionButton
            className="profile-link"
            aria-label={
              t("profile") +
              " · " +
              (message.author.display_name || message.author.username)
            }
            action={() => actions.profile(message)}
          >
            <Avatar
              app={app}
              name={message.author.username}
              user={message.author}
            />
          </ActionButton>
        )}
      </div>
      <div className="message-column">
        {!grouped && (
          <div className="message-heading">
            <ActionButton
              className={
                "author profile-link" +
                (message.author.id === mine ? " mine" : "")
              }
              action={() => actions.profile(message)}
            >
              {message.author.display_name || message.author.username}
            </ActionButton>
            {message.author.bot && (
              <span className="admin-badge bot bot-badge">
                {nt("bots.badge")}
              </span>
            )}
            <time
              className="message-time"
              title={
                actions.privateFiles ? nt("crypto.observed_time") : undefined
              }
            >
              {time}
            </time>
          </div>
        )}
        {(message.quotes || []).map((quote, index) => (
          <blockquote className="quote-card" key={index}>
            <div className="quote-author">
              {quote.excerpt?.author.display_name || ""}
            </div>
            <div>{quote.excerpt?.text || "…"}</div>
          </blockquote>
        ))}
        {message.form ? (
          <WorkflowCard message={message} mine={mine} actions={actions} />
        ) : (
          <div className="message-body">
            {editing ? (
              <InlineEditor
                message={message}
                revision={editing.revision}
                actions={actions}
                close={() => setEditing(undefined)}
              />
            ) : message.body ? (
              <Markdown nodes={message.body.nodes} />
            ) : (
              message.text
            )}
          </div>
        )}
        {message.edited_at && (
          <span className="message-note">
            {language === "fr" ? "modifié" : "edited"}
          </span>
        )}
        {(message.files || []).map((file) => (
          <FileAttachment
            key={file.id + ":" + file.sha256}
            file={file}
            actions={actions}
          />
        ))}
        {[...videos.entries()].map(([href, video]) => (
          <VideoSite
            key={video!.provider + ":" + video!.id}
            message={message}
            href={href}
            preview={message.previews?.find(
              (preview) => videoLink(preview.url)?.url === href,
            )}
            actions={actions}
          />
        ))}
        {(message.previews || [])
          .filter((preview) => !videoLink(preview.url))
          .map((preview) => (
            <PreviewCard
              key={preview.url}
              message={message}
              preview={preview}
              actions={actions}
            />
          ))}
        {(message.cards || []).map((card, index) => (
          <div
            key={index}
            className="integration-card file-card"
            style={{
              borderLeftColor:
                card.color && /^#[0-9a-f]{6}$/i.test(card.color)
                  ? card.color
                  : undefined,
            }}
          >
            {card.author && <div className="quote-author">{card.author}</div>}
            {card.title && (
              <div className="file-title">
                {card.url && safeLink(card.url) ? (
                  <a
                    href={safeLink(card.url)}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {card.title}
                  </a>
                ) : (
                  card.title
                )}
              </div>
            )}
            {card.text && <div className="message-body">{card.text}</div>}
            <div className="card-fields">
              {(card.fields || []).map((field, number) => (
                <div
                  key={number}
                  className={"card-field" + (field.short ? " short" : "")}
                >
                  <strong>{field.title}</strong>
                  <div>{field.value}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="reactions">
          {(message.reactions || []).map((reaction) => (
            <ActionButton
              key={reaction.emoji}
              className={
                "reaction" +
                (reaction.users.some((user) => user.id === mine) ? " mine" : "")
              }
              title={reaction.users
                .map((user) => user.display_name || user.username)
                .join(", ")}
              action={() => actions.reaction(message, reaction.emoji)}
            >
              <Emoji code={reaction.emoji} />
              {" " + reaction.users.length}
            </ActionButton>
          ))}
        </div>
        {message.thread && Number(message.thread.replies) > 0 && (
          <ActionButton
            className="thread-chip"
            action={() => actions.thread(message)}
          >
            {message.thread.replies + " " + t("thread")}
          </ActionButton>
        )}
      </div>
      <ActionButton
        className="row-more"
        aria-label={t("details")}
        action={(node) => actions.menu(message, node)}
      >
        •••
      </ActionButton>
      <PrivatePending message={message} actions={actions} />
    </>
  );
  return host ? (
    content
  ) : (
    <article
      ref={row}
      className={"message" + (grouped ? " grouped" : "")}
      data-id={message.id}
      data-stamp={JSON.stringify(message)}
      data-editing={editing ? "true" : undefined}
    >
      {content}
    </article>
  );
}

function PrivatePending({
  message,
  actions,
}: {
  message: Message;
  actions: RowActions;
}) {
  const pending = actions.pendingActions?.(message);
  return pending ? (
    <div className="private-pending">
      {!pending.cancelled && (
        <span className="message-note">{t("pending")}</span>
      )}
      <ActionButton action={() => pending.retry()}>{t("retry")}</ActionButton>
      {!pending.cancelled && (
        <ActionButton action={() => pending.cancel()}>
          {t("cancel")}
        </ActionButton>
      )}
    </div>
  ) : null;
}

export function Timeline({
  messages,
  mine,
  actions,
  unread,
}: {
  messages: Message[];
  mine: string;
  actions: RowActions;
  unread?: string;
}) {
  let previous: Message | undefined;
  let day = "";
  return messages.map((message) => {
    const stamp = new Date(message.created_at),
      today = new Date(),
      yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const date =
      stamp.toDateString() === today.toDateString()
        ? t("today")
        : stamp.toDateString() === yesterday.toDateString()
          ? t("yesterday")
          : stamp.toLocaleDateString(language, {
              weekday: "long",
              day: "numeric",
              month: "long",
            });
    const separator = date !== day;
    day = date;
    const grouped =
      !!previous &&
      previous.author.id === message.author.id &&
      stamp.getTime() - new Date(previous.created_at).getTime() < 300000 &&
      new Date(previous.created_at).toDateString() === stamp.toDateString();
    previous = message.system ? undefined : message;
    return (
      <Fragment key={message.id}>
        {separator && <div className="day-separator">{date}</div>}
        {message.id === unread && (
          <div className="new-marker unread-divider">{t("newMessages")}</div>
        )}
        <MessageView
          message={message}
          mine={mine}
          actions={actions}
          grouped={grouped}
        />
      </Fragment>
    );
  });
}

export function paintTimeline(
  host: HTMLElement,
  messages: Message[],
  mine: string,
  actions: RowActions,
  unread?: string,
): void {
  renderView(
    host,
    <Timeline
      messages={messages}
      mine={mine}
      actions={actions}
      unread={unread}
    />,
  );
}
export function messageRow(
  message: Message,
  mine: string,
  actions: RowActions,
  grouped = false,
): HTMLElement {
  const host = document.createElement("article");
  host.className = message.system
    ? "system-message message-system"
    : "message" + (grouped ? " grouped" : "");
  host.dataset.id = message.id;
  host.dataset.stamp = JSON.stringify(message);
  renderView(
    host,
    <MessageView
      host={host}
      message={message}
      mine={mine}
      actions={actions}
      grouped={grouped}
    />,
  );
  return host;
}
export function markdown(
  nodes: MarkdownNode[],
  depth = 0,
  _actions?: RowActions,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(elementView(<Markdown nodes={nodes} depth={depth} />));
  return fragment;
}
