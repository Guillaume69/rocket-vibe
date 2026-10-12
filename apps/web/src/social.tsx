import { useEffect, useRef, useState } from "react";
import type { App } from "./app";
import type { CreateSocial, GifList, Message, StickerList } from "./protocol";
import { operation, segment } from "./api";
import { dialog, el, button, field, actionMenu } from "./dom";
import "./social-parity.css";
import { nt as t } from "./native-i18n";
import { ActionButton } from "./ui/controls";
import { safeLink } from "./ui/links";

export const VOICE_EMOJI = ["👏", "😂", "❤️", "🎉", "👍", "👋"] as const;
function socialDialog(title: string, menu = false) {
  const [node, body] = dialog(title);
  node.classList.add("gtk-social-dialog");
  if (menu) node.classList.add("social-menu-dialog");
  return [node, body] as const;
}
function socialEntry(label: string, value = "") {
  const wrap = el("label", "social-field"),
    input = el("input", "social-entry");
  input.type = "text";
  input.value = value;
  wrap.append(el("span", "", label), input);
  return [wrap, input] as const;
}
function localDate(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}
function eventDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return (
    date.toLocaleDateString("en", { weekday: "short" }) +
    " " +
    String(date.getDate()).padStart(2, "0") +
    " " +
    date.toLocaleDateString("en", { month: "short" }) +
    " · " +
    String(date.getHours()).padStart(2, "0") +
    ":" +
    String(date.getMinutes()).padStart(2, "0")
  );
}
function parseLocalDate(value: string): Date | undefined {
  const parts = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value.trim());
  if (!parts) return;
  const [year, month, day, hour, minute] = parts.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  date.setFullYear(year);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
    ? date
    : undefined;
}
export function socialMenu(app: App, anchor: HTMLElement, root?: string): void {
  const room = app.room ? app.model.rooms.get(app.room) : undefined;
  if (!room || room.encrypted) return;
  const items: [string, () => void][] = [];
  if (app.info?.capabilities.social_cards)
    items.push(
      [t("social.poll"), () => createCard(app, "poll", root)],
      [t("social.game"), () => createCard(app, "game_night", root)],
    );
  if (app.info?.capabilities.sticker_shelf)
    items.push([t("social.shelf"), () => stickers(app, root)]);
  if (app.info?.capabilities.giphy)
    items.push(["GIF · Powered By GIPHY", () => gifs(app, "", root)]);
  const [node, body] = socialDialog(t("social.share_something"), true);
  body.append(
    ...items.map(([label, run]) =>
      button(
        label,
        () => {
          node.close();
          run();
        },
        "social-button",
      ),
    ),
  );
  void anchor;
}

function capture(app: App) {
  const room = app.room,
    account = app.account,
    opening = app.roomOpening,
    generation = app.generation,
    current = room ? app.roomFence(room) : () => false;
  return {
    room,
    current: () =>
      !!room &&
      current() &&
      app.account === account &&
      app.room === room &&
      app.roomOpening === opening &&
      app.generation === generation &&
      !app.model.rooms.get(room)?.encrypted,
  };
}
export function createCard(
  app: App,
  kind: "poll" | "game_night",
  root?: string,
): void {
  const held = capture(app);
  if (!held.room) return;
  const room = held.room,
    [node, body] = socialDialog(
      kind === "poll" ? t("social.poll") : t("social.game"),
    );
  const [tw, title] = socialEntry(t("social.title_question"));
  title.maxLength = 512;
  body.append(tw);
  const [textWrap, text] = socialEntry(
      kind === "poll"
        ? t("social.options_separated_by")
        : t("social.details_more"),
    ),
    [dw, date] = socialEntry(
      kind === "poll"
        ? t("social.optional_closing_time_yyyy_mm_dd_hh_mm")
        : t("social.date_in_your_timezone_yyyy_mm_dd_hh_mm"),
    );
  if (kind === "game_night") {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(20, 0, 0, 0);
    date.value = localDate(tomorrow);
    text.maxLength = 4096;
  }
  const multiple = el("input");
  multiple.type = "checkbox";
  body.append(textWrap, dw);
  if (kind === "poll") {
    const label = el("label", "social-multiple", t("social.multiple_choices"));
    label.prepend(multiple);
    body.append(label);
  }
  const error = el("p", "social-error");
  error.setAttribute("role", "status");
  body.append(error);
  let attempt: { body: string; id: string } | undefined;
  body.append(
    button(
      t("social.post"),
      async () => {
        if (!held.current() || !node.open) return;
        error.textContent = "";
        try {
          const at = parseLocalDate(date.value);
          if (date.value.trim() && !at)
            throw Error(t("social.check_the_date_and_time"));
          let value: CreateSocial;
          if (
            !title.value.trim() ||
            (at &&
              (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()))
          )
            throw Error(t("social.check_the_title_and_date"));
          if (kind === "poll") {
            const choices = text.value
              .split("|")
              .map((s) => s.trim())
              .filter(Boolean);
            if (
              choices.length < 2 ||
              choices.length > 10 ||
              new Set(choices.map((s) => s.toLowerCase())).size !==
                choices.length
            )
              throw Error(t("social.add_2_10_distinct_options"));
            value = {
              kind,
              operation_id: "",
              question: title.value.trim(),
              options: choices,
              multiple: multiple.checked,
              closes_at: at?.toISOString() ?? null,
              reply_to: root ?? null,
            };
          } else {
            if (!at) throw Error(t("social.choose_a_date"));
            value = {
              kind,
              operation_id: "",
              title: title.value.trim(),
              starts_at: at.toISOString(),
              description: text.value,
              reply_to: root ?? null,
            };
          }
          const fingerprint = JSON.stringify(value);
          if (attempt?.body !== fingerprint)
            attempt = { body: fingerprint, id: operation() };
          value.operation_id = attempt.id;
          await app.api.request(
            "/api/v1/rooms/" + segment(room) + "/social",
            "POST",
            value,
          );
          if (held.current()) node.close();
        } catch (reason) {
          if (held.current() && node.open)
            error.textContent =
              reason instanceof Error ? reason.message : String(reason);
        }
      },
      "social-button suggested-action",
    ),
  );
  title.focus();
}
export function gifs(
  app: App,
  query = "",
  root?: string,
  onSent?: () => void,
): HTMLDialogElement | undefined {
  const held = capture(app);
  if (!held.room) return;
  const room = held.room,
    [node, body] = dialog("GIF"),
    [qw, q] = field(t("social.search_gifs"), query);
  node.classList.add("gif-picker");
  q.maxLength = 128;
  const grid = el("div", "social-media-grid"),
    error = el("p", "error");
  let serial = 0,
    timer: ReturnType<typeof setTimeout> | undefined;
  let selected:
    | {
        item: GifList["items"][number];
        operation: string;
        saveOperation: string;
      }
    | undefined;
  let sending = false;
  const current = () =>
    held.current() && node.open && (!root || app.root === root);
  const send = button(
    t("social.send"),
    async () => {
      if (!current() || !selected || sending) return;
      const choice = selected;
      sending = true;
      q.disabled = true;
      grid.inert = true;
      try {
        await app.api.request(
          "/api/v1/rooms/" + segment(room) + "/images",
          "POST",
          {
            operation_id: choice.operation,
            title: choice.item.title || "GIF",
            url: choice.item.url,
            reply_to: root ?? null,
          },
        );
        if (current()) {
          onSent?.();
          node.close();
        }
      } finally {
        sending = false;
        q.disabled = false;
        grid.inert = false;
      }
    },
    "suggested",
  );
  send.disabled = true;
  const save = button(t("social.save_to_sticker_shelf"), async () => {
    if (!current() || !selected || sending) return;
    const choice = selected;
    await app.api.request("/api/v1/stickers", "POST", {
      operation_id: choice.saveOperation,
      name: (choice.item.title || "GIF").slice(0, 100),
      url: choice.item.url,
    });
    if (current() && selected === choice) {
      save.textContent = t("social.saved");
      save.disabled = true;
    }
  });
  save.disabled = true;
  const search = async () => {
    const version = ++serial,
      term = q.value;
    selected = undefined;
    send.disabled = true;
    save.disabled = true;
    error.textContent = "";
    grid.replaceChildren(el("p", "dim", t("social.searching")));
    try {
      const result = await app.api.request<GifList>(
        "/api/v1/gifs?q=" + encodeURIComponent(term),
      );
      if (!current() || version !== serial) return;
      grid.replaceChildren();
      for (const item of result.items) {
        const wrap = el("div", "social-media-item"),
          image = el("img");
        image.src = item.url;
        image.alt = item.title;
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
        const sendId = operation(),
          saveId = operation();
        const choose = button(
          item.title || t("social.select"),
          () => {
            if (!current() || sending || version !== serial) return;
            selected = { item, operation: sendId, saveOperation: saveId };
            for (const option of grid.querySelectorAll<HTMLButtonElement>(
              ".gif-choice",
            ))
              option.setAttribute("aria-pressed", String(option === choose));
            send.disabled = false;
            save.disabled = false;
            save.textContent = t("social.save_to_sticker_shelf");
            q.focus();
          },
          "flat gif-choice",
        );
        choose.setAttribute("aria-pressed", "false");
        choose.setAttribute("aria-label", item.title || t("social.select"));
        choose.replaceChildren(
          image,
          el("span", "", item.title || t("social.select")),
        );
        wrap.append(choose);
        grid.append(wrap);
      }
      if (!result.items.length)
        grid.append(el("p", "dim", t("social.no_gifs_found")));
    } catch (e) {
      if (!current() || version !== serial) return;
      grid.replaceChildren();
      error.textContent =
        e instanceof Error && e.message === "giphy_not_configured"
          ? t("social.gif_search_is_not_enabled_on_this_server")
          : t("social.search_failed_try_again");
    }
  };
  const footer = el("div", "gif-footer");
  footer.append(el("span", "dim", "Powered By GIPHY"), save, send);
  body.append(qw, error, grid, footer);
  q.addEventListener("input", () => {
    ++serial;
    selected = undefined;
    send.disabled = true;
    save.disabled = true;
    grid.replaceChildren(el("p", "dim", t("social.searching")));
    clearTimeout(timer);
    timer = setTimeout(() => void search(), 300);
  });
  node.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      !event.isComposing &&
      !event.shiftKey &&
      !(event.target instanceof HTMLButtonElement)
    ) {
      event.preventDefault();
      if (!send.disabled) send.click();
    }
  });
  node.addEventListener("close", () => {
    ++serial;
    clearTimeout(timer);
  });
  q.focus();
  void search();
  return node;
}
export function stickers(app: App, root?: string): void {
  const held = capture(app);
  if (!held.room) return;
  const room = held.room,
    [node, body] = socialDialog(t("social.shelf")),
    [nw, name] = socialEntry(t("social.search_name")),
    [uw, url] = socialEntry(t("social.image_link")),
    error = el("p", "social-error"),
    grid = el("div", "social-shelf-list");
  error.setAttribute("role", "status");
  name.maxLength = 100;
  const current = () => held.current() && node.open;
  let serial = 0;
  const load = async () => {
    const version = ++serial;
    const value = await app.api.request<StickerList>("/api/v1/stickers");
    if (!current() || version !== serial) return;
    grid.replaceChildren();
    for (const item of value.stickers) {
      const wrap = el("div", "social-shelf-item"),
        controls = el("div", "social-shelf-controls"),
        image = el("img");
      image.src = item.url;
      image.alt = item.name;
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("load", () => {
        if (!current() || !wrap.isConnected) return;
        const scale =
          512 / Math.max(image.naturalWidth, image.naturalHeight, 512);
        image.style.width =
          Math.max(180, Math.floor(image.naturalWidth * scale)) + "px";
        image.style.height =
          Math.max(150, Math.floor(image.naturalHeight * scale)) + "px";
      });
      const id = operation();
      controls.append(
        el("span", "", item.name),
        button(
          t("social.send"),
          async () => {
            if (!current()) return;
            await app.api.request(
              "/api/v1/rooms/" + segment(room) + "/images",
              "POST",
              {
                operation_id: id,
                title: item.name,
                url: item.url,
                reply_to: root ?? null,
              },
            );
            if (current()) node.close();
          },
          "social-button suggested-action",
        ),
        button(
          t("social.remove"),
          async () => {
            if (!current()) return;
            await app.api.request(
              "/api/v1/stickers/" + segment(item.id),
              "DELETE",
            );
            if (current()) await load();
          },
          "social-button",
        ),
      );
      wrap.append(image, controls);
      grid.append(wrap);
    }
    if (!value.stickers.length)
      grid.append(el("p", "social-empty", t("social.empty")));
  };
  let attempt: { body: string; id: string } | undefined;
  body.append(
    nw,
    uw,
    error,
    grid,
    button(
      t("social.search_refresh"),
      async () => {
        try {
          await load();
        } catch (reason) {
          if (current())
            error.textContent =
              reason instanceof Error ? reason.message : String(reason);
        }
      },
      "social-button",
    ),
    button(
      t("social.add"),
      async () => {
        if (!current()) return;
        error.textContent = "";
        try {
          const value = { name: name.value.trim(), url: url.value.trim() };
          const fingerprint = JSON.stringify(value);
          if (attempt?.body !== fingerprint)
            attempt = { body: fingerprint, id: operation() };
          await app.api.request("/api/v1/stickers", "POST", {
            ...value,
            operation_id: attempt.id,
          });
          if (current()) {
            await load();
          }
        } catch (reason) {
          if (current())
            error.textContent =
              reason instanceof Error ? reason.message : String(reason);
        }
      },
      "social-button",
    ),
  );
  name.focus();
  void load().catch((reason) => {
    if (current())
      error.textContent =
        reason instanceof Error ? reason.message : String(reason);
  });
}
export function SocialMessage({
  app,
  message,
}: {
  app: App;
  message: Message;
}) {
  const social = message.social,
    me = app.account?.session.user.id ?? "",
    [tick, setTick] = useState(0);
  useEffect(() => {
    if (!social) return;
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [social?.kind]);
  void tick;
  const serverChoices =
    social?.kind === "poll"
      ? social.options.flatMap((o, i) => (o.voters.includes(me) ? [i] : []))
      : social?.kind === "game_night"
        ? [
            social.going.includes(me)
              ? 0
              : social.maybe.includes(me)
                ? 1
                : social.declined.includes(me)
                  ? 2
                  : -1,
          ].filter((n) => n >= 0)
        : [];
  const [choices, setChoices] = useState(serverChoices);
  const [failure, setFailure] = useState("");
  const [savedImage, setSavedImage] = useState(false);
  useEffect(() => setSavedImage(false), [message.id]);
  const signature = serverChoices.join(",");
  useEffect(() => setChoices(serverChoices), [signature, message.id]);
  const attempt = useRef<{ body: string; id: string } | undefined>(undefined);
  const current = app.roomFence(message.room_id);
  if (!social) return null;
  const run = async (action: () => Promise<unknown>) => {
    if (!current()) return;
    setFailure("");
    try {
      await action();
    } catch (reason) {
      if (current())
        setFailure(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const send = () =>
    run(async () => {
      if (!current()) return;
      const body = JSON.stringify(choices);
      if (attempt.current?.body !== body)
        attempt.current = { body, id: operation() };
      await app.api.request(
        "/api/v1/messages/" + segment(message.id) + "/social/answer",
        "POST",
        { operation_id: attempt.current.id, choices },
      );
    });
  if (social.kind === "image")
    return safeLink(social.url) ? (
      <section className="social-card social-image">
        <img
          src={social.url}
          alt={social.title}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
        <strong>{social.title}</strong>
        {social.powered_by && (
          <span className="social-image-attribution">
            {"Powered By " + social.powered_by}
          </span>
        )}
        <ActionButton
          action={async () => {
            if (!current()) return;
            await app.api.request("/api/v1/stickers", "POST", {
              operation_id: operation(),
              name: social.title.slice(0, 100) || "Sticker",
              url: social.url,
            });
            if (current()) setSavedImage(true);
          }}
        >
          {t(savedImage ? "social.saved" : "social.save_to_sticker_shelf")}
        </ActionButton>
      </section>
    ) : null;
  if (social.kind === "poll") {
    const ended =
      social.closed ||
      (!!social.closes_at && Date.parse(social.closes_at) <= Date.now());
    return (
      <section className="social-card">
        <strong>{social.question}</strong>
        {social.options.map((o, i) => (
          <label key={i} className="poll-option">
            <input
              type={social.multiple ? "checkbox" : "radio"}
              checked={choices.includes(i)}
              disabled={ended}
              onChange={() =>
                setChoices((old) =>
                  social.multiple
                    ? old.includes(i)
                      ? old.filter((n) => n !== i)
                      : [...old, i].sort((a, b) => a - b)
                    : [i],
                )
              }
            />
            <span>
              {o.label} · {o.voters.length}
            </span>
          </label>
        ))}
        <span className="social-card-error" role="status">
          {failure}
        </span>
        {ended ? (
          <span>{t("social.closed")}</span>
        ) : (
          <div className="social-actions">
            <ActionButton action={send}>{t("social.vote")}</ActionButton>
            <ActionButton
              action={() =>
                run(async () => {
                  setChoices([]);
                  await app.api.request(
                    "/api/v1/messages/" +
                      segment(message.id) +
                      "/social/answer",
                    "POST",
                    { operation_id: operation(), choices: [] },
                  );
                })
              }
            >
              {t("social.clear")}
            </ActionButton>
            {message.author.id === me && (
              <ActionButton
                action={() =>
                  run(() =>
                    app.api.request(
                      "/api/v1/messages/" +
                        segment(message.id) +
                        "/social/close",
                      "POST",
                      { operation_id: operation() },
                    ),
                  )
                }
              >
                {t("social.close")}
              </ActionButton>
            )}
          </div>
        )}
      </section>
    );
  }
  const ended = Date.parse(social.starts_at) <= Date.now();
  return (
    <section className="social-card game-night">
      <strong>{social.title}</strong>
      <time dateTime={social.starts_at}>{eventDate(social.starts_at)}</time>
      <p>{social.description}</p>
      <span className="social-card-error" role="status">
        {failure}
      </span>
      <div className="social-actions">
        {[t("social.going"), t("social.maybe"), t("social.declined")].map(
          (label, i) => (
            <ActionButton
              key={i}
              disabled={ended}
              aria-pressed={choices.includes(i)}
              action={() =>
                run(() =>
                  app.api.request(
                    "/api/v1/messages/" +
                      segment(message.id) +
                      "/social/answer",
                    "POST",
                    { operation_id: operation(), choices: [i] },
                  ),
                )
              }
            >
              {label} ·{" "}
              {[social.going, social.maybe, social.declined][i]?.length}
            </ActionButton>
          ),
        )}
      </div>
      {app.info?.capabilities.voice && (
        <ActionButton action={() => app.voice.join()}>
          {t("social.join_voice")}
        </ActionButton>
      )}
    </section>
  );
}
export function reactVoice(app: App, anchor: HTMLElement): void {
  const room = app.voice.current;
  if (!room || app.model.rooms.get(room)?.encrypted) return;
  actionMenu(
    anchor,
    VOICE_EMOJI.map((emoji) => [
      emoji,
      async () => {
        if (app.voice.current !== room) return;
        await app.api.request(
          "/api/v1/rooms/" + segment(room) + "/voice/reactions",
          "POST",
          { operation_id: operation(), emoji },
        );
      },
    ]),
    true,
  );
}
