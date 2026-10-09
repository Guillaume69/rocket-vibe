import type {
  Message,
  Node as MarkdownNode,
  FileDescriptor,
  User,
  PreviewImage,
} from "./protocol";
import { el, tile, button } from "./dom";
import { t, language } from "./i18n";
import { systemText } from "./presentation";
import { emojiGlyph } from "./emoji";
import { videoCard } from "./video";
import { videoLink, videoLinks } from "./video-links";
import { iconButton } from "./icons";
import { botBadge } from "./bots";
import { formCard } from "./workflow-forms";
import { videoAttachment } from "./video-attachment";
import { inlineImage, imageAttachment } from "./image-attachment";
import { humanSize } from "./media-format";
import { nt } from "./native-i18n";
export function safeLink(href: string): string | undefined {
  try {
    const url = new URL(href, location.origin);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function markdown(
  nodes: MarkdownNode[],
  depth = 0,
  actions?: RowActions,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (depth > 32) return fragment;
  for (const item of nodes) {
    let node: HTMLElement;
    switch (item.kind) {
      case "text":
        fragment.append(document.createTextNode(item.text));
        continue;
      case "break":
        fragment.append(el("br"));
        continue;
      case "rule":
        fragment.append(el("hr"));
        continue;
      case "mention":
        node = el("span", "mention", "@" + item.name);
        actions?.mention(item.name, node);
        break;
      case "room_mention":
        node = el("span", "mention", "#" + item.name);
        break;
      case "emoji":
        node = el("span", "emoji", emojiGlyph(item.shortcode));
        actions?.emoji(item.shortcode, node);
        break;
      case "inline_code":
        node = el("code", "", item.text);
        break;
      case "code_block":
        node = el("pre", "md-code");
        node.append(el("code", "", item.text));
        break;
      case "heading":
        node = el(
          ("h" + Math.max(1, Math.min(4, item.level))) as "h1",
          "md-h" + item.level,
        );
        break;
      case "bold":
        node = el("strong");
        break;
      case "italic":
        node = el("em");
        break;
      case "strike":
        node = el("s");
        break;
      case "quote":
        node = el("blockquote", "md-quote");
        break;
      case "list":
        node = item.start ? el("ol") : el("ul");
        if (node instanceof HTMLOListElement && item.start)
          node.start = item.start;
        break;
      case "list_item":
        node = el("li");
        if (item.checked != null)
          node.append(el("span", "", item.checked ? "☑ " : "☐ "));
        break;
      case "link": {
        const href = safeLink(item.href);
        if (!href) {
          fragment.append(markdown(item.children, depth + 1, actions));
          continue;
        }
        const link = el("a");
        link.href = href;
        link.rel = "noopener noreferrer";
        link.target = "_blank";
        node = link;
        break;
      }
      default:
        node = el("p");
        break;
    }
    if ("children" in item)
      node.append(markdown(item.children, depth + 1, actions));
    fragment.append(node);
  }
  return fragment;
}
export interface RowActions {
  profile(message: Message): Promise<void>;
  menu(message: Message, anchor: HTMLElement): Promise<void>;
  answerForm(message: Message): Promise<void>;
  thread(message: Message): Promise<void>;
  reaction(message: Message, emoji: string): Promise<void>;
  file(file: FileDescriptor, node: HTMLElement): Promise<void>;
  avatar(user: User, node: HTMLElement): void;
  emoji(code: string, node: HTMLElement): void;
  mention(name: string, node: HTMLElement): void;
  previewImage(
    message: Message,
    image: PreviewImage,
    node: HTMLElement,
  ): Promise<void>;
}
export function messageRow(
  message: Message,
  mine: string,
  actions: RowActions,
  grouped = false,
): HTMLElement {
  const row = el("article", "message" + (grouped ? " grouped" : ""));
  row.dataset.id = message.id;
  row.dataset.stamp = JSON.stringify(message);
  if (message.system) {
    row.className = "system-message message-system";
    row.textContent = systemText(message);
    return row;
  }
  const gutter = el("div", "message-gutter");
  if (!grouped) {
    const portrait = tile(message.author.username);
    actions.avatar(message.author, portrait);
    const open = button("", () => actions.profile(message), "profile-link");
    open.setAttribute(
      "aria-label",
      t("profile") +
        " · " +
        (message.author.display_name || message.author.username),
    );
    open.append(portrait);
    gutter.append(open);
  } else
    gutter.append(
      el(
        "span",
        "gutter-time",
        new Date(message.created_at).toLocaleTimeString(language, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      ),
    );
  const column = el("div", "message-column");
  if (!grouped) {
    const header = el("div", "message-heading");
    header.append(
      button(
        message.author.display_name || message.author.username,
        () => actions.profile(message),
        "author profile-link" + (message.author.id === mine ? " mine" : ""),
      ),
      el(
        "time",
        "message-time",
        new Date(message.created_at).toLocaleTimeString(language, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      ),
    );
    if (message.author.bot)
      header.insertBefore(botBadge(), header.lastElementChild);
    column.append(header);
  }
  for (const quote of message.quotes || []) {
    const card = el("blockquote", "quote-card");
    card.append(
      el("div", "quote-author", quote.excerpt?.author.display_name || ""),
      el("div", "", quote.excerpt?.text || "…"),
    );
    column.append(card);
  }
  const body = el("div", "message-body");
  if (message.body) body.append(markdown(message.body.nodes, 0, actions));
  else body.textContent = message.text;
  if (message.form)
    column.append(
      formCard(message, mine, (value) => actions.answerForm(value)),
    );
  else column.append(body);
  if (message.edited_at)
    column.append(
      el("span", "message-note", language === "fr" ? "modifié" : "edited"),
    );
  for (const file of message.files || []) {
    if (inlineImage(file)) {
      column.append(
        imageAttachment(file, (file, node) => actions.file(file, node)),
      );
      continue;
    }
    if (file.media_type.startsWith("video/") && !file.encrypted) {
      column.append(
        videoAttachment(file, (file, node) => actions.file(file, node)),
      );
      continue;
    }
    const card = el("div", "file-card");
    card.dataset.fileId = file.id;
    card.dataset.fileHash = file.sha256;
    const top = el("div", "file-top"),
      names = el("div", "file-names");
    names.append(
      el("div", "file-title", file.filename || file.media_type),
      el("div", "file-detail", humanSize(file.bytes) + " · " + file.media_type),
    );
    top.append(
      el(
        "span",
        "file-icon",
        file.media_type.startsWith("audio/") ? "🎵" : "📄",
      ),
      names,
    );
    const playable =
      file.media_type.startsWith("audio/") ||
      file.media_type.startsWith("video/");
    if (playable)
      top.append(
        button(
          language === "fr" ? "Lire" : "Play",
          async () => {
            await actions.file(file, card);
            await card.querySelector<HTMLMediaElement>("audio,video")?.play();
          },
          "file-play-trigger file-action",
        ),
      );
    top.append(
      iconButton(
        "download",
        t("download"),
        async () => {
          await actions.file(file, card);
          card.querySelector<HTMLAnchorElement>("a.file-download")?.click();
        },
        "file-download-trigger",
      ),
    );
    if (playable) {
      const play = top.querySelector(".file-play-trigger");
      if (play) top.append(play);
    }
    if (!playable)
      top.append(
        button(
          nt("file.open"),
          async () => {
            await actions.file(file, card);
            card.querySelector<HTMLAnchorElement>(".file-download")?.click();
          },
          "file-action",
        ),
      );
    card.append(top);
    column.append(card);
  }
  const videos = new Set<string>();
  const videoCandidates = [
    ...body.querySelectorAll<HTMLAnchorElement>("a[href]"),
  ]
    .map((link) => link.href)
    .concat(videoLinks(message.text).map((video) => video.url));
  for (const href of videoCandidates) {
    const video = videoLink(href);
    if (!video || videos.has(video.url) || videos.size >= 3) continue;
    const preview = message.previews?.find(
      (preview) => videoLink(preview.url)?.url === video.url,
    );
    const card = videoCard(href, preview);
    if (card) {
      videos.add(video.url);
      column.append(card);
      if (preview?.image && BigInt(preview.image.bytes) < 10n * 1024n * 1024n)
        void actions
          .previewImage(
            message,
            preview.image,
            card.querySelector<HTMLElement>(".video-thumb")!,
          )
          .catch(() => {});
    }
  }
  for (const preview of message.previews || []) {
    if (videoLink(preview.url)) continue;
    const href = safeLink(preview.url);
    if (!href) continue;
    const card = el("a", "link-card");
    card.href = href;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.append(
      el("div", "link-title", preview.title || preview.url),
      el("div", "link-description", preview.description || ""),
    );
    column.append(card);
    if (preview.image && BigInt(preview.image.bytes) < 10n * 1024n * 1024n)
      void actions.previewImage(message, preview.image, card).catch(() => {});
  }
  for (const content of message.cards || []) {
    const card = el("div", "integration-card file-card");
    if (content.color && /^#[0-9a-f]{6}$/i.test(content.color))
      card.style.borderLeftColor = content.color;
    if (content.author) card.append(el("div", "quote-author", content.author));
    if (content.title) {
      const title = el("div", "file-title", content.title);
      if (content.url) {
        const url = safeLink(content.url);
        if (url) {
          const link = el("a", "", content.title);
          link.href = url;
          link.rel = "noopener noreferrer";
          link.target = "_blank";
          title.replaceChildren(link);
        }
      }
      card.append(title);
    }
    if (content.text) card.append(el("div", "message-body", content.text));
    const fields = el("div", "card-fields");
    for (const field of content.fields || []) {
      const group = el("div", "card-field" + (field.short ? " short" : ""));
      group.append(el("strong", "", field.title), el("div", "", field.value));
      fields.append(group);
    }
    card.append(fields);
    column.append(card);
  }
  const reactions = el("div", "reactions");
  for (const reaction of message.reactions || []) {
    const chip = button(
      emojiGlyph(reaction.emoji) + " " + reaction.users.length,
      () => actions.reaction(message, reaction.emoji),
      "reaction" +
        (reaction.users.some((user) => user.id === mine) ? " mine" : ""),
    );
    const glyph = el("span", "emoji", emojiGlyph(reaction.emoji));
    actions.emoji(reaction.emoji, glyph);
    chip.replaceChildren(
      glyph,
      document.createTextNode(" " + reaction.users.length),
    );
    chip.title = reaction.users
      .map((user) => user.display_name || user.username)
      .join(", ");
    reactions.append(chip);
  }
  column.append(reactions);
  if (message.thread && Number(message.thread.replies) > 0)
    column.append(
      button(
        message.thread.replies + " " + t("thread"),
        () => actions.thread(message),
        "thread-chip",
      ),
    );
  const menu = button("•••", () => actions.menu(message, menu), "row-more");
  menu.setAttribute("aria-label", t("details"));
  row.append(gutter, column, menu);
  return row;
}
