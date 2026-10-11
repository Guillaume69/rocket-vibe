import { useEffect, useRef, useState } from "react";
import type { App } from "./app";
import type { CreateSocial, GifList, Message, StickerList } from "./protocol";
import { operation, segment } from "./api";
import { dialog, el, button, field, toast, actionMenu } from "./dom";
import { nt as t } from "./native-i18n";
import { ActionButton } from "./ui/controls";
import { safeLink } from "./ui/links";

export const VOICE_EMOJI = ["👏", "😂", "❤️", "🎉", "👍", "👋"] as const;
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
  actionMenu(anchor, items, true);
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
    [node, body] = dialog(
      kind === "poll" ? t("social.poll") : t("social.game"),
    );
  const [tw, title] = field(
    kind === "poll" ? t("social.question") : t("social.title_more"),
  );
  title.maxLength = 512;
  body.append(tw);
  const options = el("textarea", "native-entry"),
    description = el("textarea", "native-entry"),
    [dw, date] = field(
      kind === "poll"
        ? t("social.closing_time_optional")
        : t("social.date_and_time_in_your_timezone"),
      "",
      "datetime-local",
    );
  date.min = new Date(
    Date.now() + 60_000 - new Date().getTimezoneOffset() * 60_000,
  )
    .toISOString()
    .slice(0, 16);
  const multiple = el("input");
  multiple.type = "checkbox";
  if (kind === "poll") {
    options.placeholder = t("social.options");
    options.setAttribute("aria-label", options.placeholder);
    options.rows = 5;
    body.append(options);
    const label = el("label", "field", t("social.multiple"));
    label.prepend(multiple);
    body.append(label, dw);
  } else {
    description.placeholder = t("social.details");
    description.setAttribute("aria-label", description.placeholder);
    description.rows = 3;
    description.maxLength = 4096;
    body.append(dw, description);
  }
  let attempt: { body: string; id: string } | undefined;
  body.append(
    button(
      t("social.post"),
      async () => {
        if (!held.current() || !node.open) return;
        const at = date.value ? new Date(date.value) : undefined;
        let value: CreateSocial;
        if (
          !title.value.trim() ||
          (at && (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()))
        )
          throw Error(t("social.check_the_title_and_date"));
        if (kind === "poll") {
          const choices = options.value
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (
            choices.length < 2 ||
            choices.length > 10 ||
            new Set(choices.map((s) => s.toLowerCase())).size !== choices.length
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
            description: description.value,
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
      },
      "suggested",
    ),
  );
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
    [node, body] = dialog(t("social.shelf")),
    [nw, name] = field(t("social.name")),
    [uw, url] = field(t("social.image_link"), "", "url"),
    grid = el("div", "social-media-grid");
  name.maxLength = 100;
  url.placeholder = "https://…";
  const current = () => held.current() && node.open;
  let serial = 0;
  const load = async () => {
    const version = ++serial;
    const value = await app.api.request<StickerList>("/api/v1/stickers");
    if (!current() || version !== serial) return;
    grid.replaceChildren();
    for (const item of value.stickers) {
      const wrap = el("div", "social-media-item"),
        image = el("img");
      image.src = item.url;
      image.alt = item.name;
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      const id = operation();
      wrap.append(
        image,
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
          "suggested",
        ),
        button(t("social.remove"), async () => {
          if (!current()) return;
          await app.api.request(
            "/api/v1/stickers/" + segment(item.id),
            "DELETE",
          );
          if (current()) await load();
        }),
      );
      grid.append(wrap);
    }
    if (!value.stickers.length)
      grid.append(
        el("p", "dim", t("social.add_your_images_or_save_a_gif_from_search")),
      );
  };
  let attempt: { body: string; id: string } | undefined;
  body.append(
    grid,
    nw,
    uw,
    button(t("social.add"), async () => {
      if (!current()) return;
      const value = { name: name.value.trim(), url: url.value.trim() };
      const fingerprint = JSON.stringify(value);
      if (attempt?.body !== fingerprint)
        attempt = { body: fingerprint, id: operation() };
      await app.api.request("/api/v1/stickers", "POST", {
        ...value,
        operation_id: attempt.id,
      });
      if (current()) {
        name.value = "";
        url.value = "";
        await load();
      }
    }),
  );
  void load().catch(toast);
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
  const signature = serverChoices.join(",");
  useEffect(() => setChoices(serverChoices), [signature, message.id]);
  const attempt = useRef<{ body: string; id: string } | undefined>(undefined);
  const current = app.roomFence(message.room_id);
  if (!social) return null;
  const send = async () => {
    if (!current()) return;
    const body = JSON.stringify(choices);
    if (attempt.current?.body !== body)
      attempt.current = { body, id: operation() };
    await app.api.request(
      "/api/v1/messages/" + segment(message.id) + "/social/answer",
      "POST",
      { operation_id: attempt.current.id, choices },
    );
  };
  if (social.kind === "image")
    return safeLink(social.url) ? (
      <figure className="social-image">
        <img
          src={social.url}
          alt={social.title}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
        <figcaption>
          {social.powered_by && "Powered By " + social.powered_by}
          <ActionButton
            action={() =>
              app.api.request("/api/v1/stickers", "POST", {
                operation_id: operation(),
                name: social.title.slice(0, 100) || "Sticker",
                url: social.url,
              })
            }
          >
            {t("social.save")}
          </ActionButton>
        </figcaption>
      </figure>
    ) : null;
  if (social.kind === "poll") {
    const ended =
        social.closed ||
        (!!social.closes_at && Date.parse(social.closes_at) <= Date.now()),
      people = new Set(social.options.flatMap((o) => o.voters)).size;
    return (
      <section className="social-card">
        <strong>{social.question}</strong>
        <span className="dim">
          {social.multiple
            ? t("social.multiple_choices")
            : t("social.one_choice")}
        </span>
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
            <span>{o.label}</span>
            <span>{o.voters.length}</span>
            <progress max={Math.max(people, 1)} value={o.voters.length} />
          </label>
        ))}
        <span>
          {people} {t("social.participants")}
          {social.closes_at &&
            " · " + new Date(social.closes_at).toLocaleString()}
        </span>
        {ended ? (
          <span>{t("social.closed")}</span>
        ) : (
          <div className="social-actions">
            <ActionButton action={send}>{t("social.vote")}</ActionButton>
            <ActionButton
              action={() => {
                setChoices([]);
                return app.api.request(
                  "/api/v1/messages/" + segment(message.id) + "/social/answer",
                  "POST",
                  { operation_id: operation(), choices: [] },
                );
              }}
            >
              {t("social.clear")}
            </ActionButton>
            {message.author.id === me && (
              <ActionButton
                action={() =>
                  app.api.request(
                    "/api/v1/messages/" + segment(message.id) + "/social/close",
                    "POST",
                    { operation_id: operation() },
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
      <time dateTime={social.starts_at}>
        {new Date(social.starts_at).toLocaleString()}
      </time>
      <p>{social.description}</p>
      <div className="social-actions">
        {[t("social.going"), t("social.maybe"), t("social.declined")].map(
          (label, i) => (
            <ActionButton
              key={i}
              disabled={ended}
              aria-pressed={choices.includes(i)}
              action={() =>
                app.api.request(
                  "/api/v1/messages/" + segment(message.id) + "/social/answer",
                  "POST",
                  { operation_id: operation(), choices: [i] },
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
      {!ended && (
        <ActionButton
          action={() =>
            app.setReminder(
              message,
              new Date(
                Math.max(
                  Date.now() + 60_000,
                  Date.parse(social.starts_at) - 10 * 60_000,
                ),
              ),
            )
          }
        >
          {t("social.remind_me_beforehand")}
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
