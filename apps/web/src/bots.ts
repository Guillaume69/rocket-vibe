import type { App } from "./app";
import type {
  Bot,
  BotList,
  BotReference,
  BotScope,
  BotKeyList,
  BotKeyCreated,
  AccountPermissions,
} from "./protocol";
import { operation, segment } from "./api";
import { el, tile, button, toast } from "./dom";
import { preferencesGroup, actionRow, type SidebarHost } from "./sidebar";
import {
  accountFence,
  entryRow,
  confirmAction,
  onceSecret,
} from "./preferences-controls";
import { recentProof } from "./security";
import { iconButton } from "./icons";
import { nt } from "./native-i18n";
import { t } from "./i18n";
export const botBadge = () =>
  el("span", "admin-badge bot bot-badge", nt("bots.badge"));
const scopes: BotScope[] = [
  "rooms:read",
  "messages:write",
  "files:write",
  "reactions:write",
  "rooms:join",
  "users:read",
  "dm:write",
];
export function scopesGroup(
  reference: BotReference | undefined,
  chosen: BotScope[],
): HTMLElement {
  const [group, rows] = preferencesGroup(nt("bots.scopes"));
  for (const scope of [...scopes, null]) {
    const details = el("details", "scope-row");
    const summary = el("summary", "action-row");
    if (scope) {
      const check = el("input");
      check.type = "checkbox";
      check.checked = chosen.includes(scope);
      check.setAttribute("aria-label", scope);
      check.addEventListener("click", (e) => e.stopPropagation());
      check.addEventListener("change", () => {
        const index = chosen.indexOf(scope);
        if (check.checked && index < 0) chosen.push(scope);
        else if (!check.checked && index >= 0) chosen.splice(index, 1);
      });
      summary.append(check);
    }
    const text = el("div", "action-row-text");
    text.append(
      el(
        "span",
        "action-row-title",
        nt(
          scope ? "bots.scope." + scope.replace(":", "_") : "bots.scope.always",
        ),
      ),
      el(
        "span",
        "action-row-subtitle",
        scope ? scope + " · " + nt("bots.api") : nt("bots.api"),
      ),
    );
    summary.append(text);
    details.append(summary);
    for (const route of reference?.groups.find(
      (g) => (g.scope ?? null) === scope,
    )?.routes ?? [])
      details.append(
        el(
          "code",
          "bot-route",
          route.method +
            " " +
            route.path +
            (route.also?.length ? " · " + route.also.join(", ") : ""),
        ),
      );
    rows.append(details);
  }
  group.append(
    el(
      "p",
      "dim",
      nt("bots.closed_routes") +
        " " +
        (reference
          ? nt("bots.budgets", {
              sends: reference.sends_per_minute,
              direct: reference.direct_per_minute,
            })
          : ""),
    ),
  );
  return group;
}
export async function botsPage(
  app: App,
  host: SidebarHost,
  page: HTMLElement,
  all = false,
): Promise<void> {
  const valid = accountFence(app);
  page.classList.add("native-bots");
  const [mine, permission, reference] = await Promise.all([
    app.api.request<BotList>("/api/v1/bots" + (all ? "?all=true" : "")),
    app.api.request<AccountPermissions>("/api/v1/me/permissions"),
    app.api.request<BotReference>("/api/v1/bots/reference"),
  ]);
  if (!valid() || !page.isConnected) return;
  const [group, rows] = preferencesGroup(nt(all ? "admin.bots" : "bots.title"));
  group.append(el("p", "dim", nt("bots.intro")));
  group.querySelector("h3")?.append(
    iconButton("refresh", nt("security.refresh"), () => {
      page.replaceChildren();
      return botsPage(app, host, page, all);
    }),
  );
  if (!mine.bots.length) rows.append(actionRow(nt("bots.empty")));
  const show = (bot: Bot) =>
    host.push(bot.user.display_name || bot.user.username, (p) =>
      botDetail(app, host, p, bot, reference, all),
    );
  for (const bot of mine.bots) {
    const row = actionRow(
      bot.user.display_name || bot.user.username,
      "@" +
        bot.user.username +
        " · " +
        nt("bots.keys_count", { n: bot.live_keys }),
      () => show(bot),
    );
    const portrait = tile(bot.user.username);
    app.avatar(bot.user, portrait);
    row.prepend(portrait);
    row.insertBefore(botBadge(), row.lastElementChild);
    if (bot.disabled)
      row.append(el("span", "admin-badge deactivated", nt("bots.disabled")));
    rows.append(row);
  }
  if (!all && permission.create_bot)
    rows.append(
      actionRow(nt("bots.create"), "", () =>
        host.push(nt("bots.create"), create),
      ),
    );
  else if (!all) rows.append(actionRow(nt("bots.closed")));
  page.append(group);
  function create(content: HTMLElement) {
    let username = "",
      display_name = "",
      description = "";
    const chosen: BotScope[] = [];
    const [fields, values] = preferencesGroup();
    values.append(
      entryRow(nt("bots.username"), username, (v) => (username = v)),
      entryRow(
        nt("bots.display_name"),
        display_name,
        (v) => (display_name = v),
      ),
      entryRow(nt("bots.description"), description, (v) => (description = v)),
    );
    const [actions, buttons] = preferencesGroup();
    buttons.append(
      actionRow(nt("bots.create"), "", async () => {
        if (!valid()) return;
        const bot = await app.api.request<Bot>("/api/v1/bots", "POST", {
          operation_id: operation(),
          username: username.trim(),
          display_name: display_name.trim(),
          description: description.trim(),
          scopes: chosen,
        });
        if (!valid()) return;
        host.pop();
        page.replaceChildren();
        await botsPage(app, host, page);
        show(bot);
      }),
    );
    content.append(fields, scopesGroup(reference, chosen), actions);
  }
}
async function botDetail(
  app: App,
  host: SidebarHost,
  page: HTMLElement,
  initial: Bot,
  reference: BotReference,
  all: boolean,
): Promise<void> {
  const valid = accountFence(app);
  let bot = initial;
  const path = "/api/v1/bots/" + segment(bot.user.id);
  const owner = bot.owner.id === app.account?.session.user.id;
  page.classList.add("native-bot");
  const [identity, rows] = preferencesGroup();
  const photo = actionRow(bot.user.display_name, "@" + bot.user.username);
  const portrait = tile(bot.user.username, "room");
  app.avatar(bot.user, portrait);
  photo.prepend(portrait);
  rows.append(photo);
  if (owner) {
    const picker = el("input");
    picker.type = "file";
    picker.hidden = true;
    picker.accept = "image/png,image/jpeg";
    const apply = async (file?: File) => {
      if (!valid()) return;
      if (file && file.size > 2 * 1024 * 1024)
        throw Error(nt("bots.error_avatar_too_large"));
      bot = await app.api.request<Bot>(
        path + "/avatar",
        file ? "PUT" : "DELETE",
        file,
      );
      if (valid() && page.isConnected) {
        app.profiles.delete(bot.user.id);
        page.replaceChildren();
        await botDetail(app, host, page, bot, reference, all);
      }
    };
    picker.addEventListener("change", () => {
      const file = picker.files?.[0];
      if (file) void apply(file).catch(toast);
    });
    photo.append(
      button(nt("settings.photo_change"), () => picker.click()),
      button(nt("settings.photo_remove"), () => apply()),
      picker,
    );
    const selected = [...bot.scopes];
    let display_name = bot.user.display_name,
      description = bot.description;
    const [fields, values] = preferencesGroup();
    values.append(
      entryRow(
        nt("bots.display_name"),
        display_name,
        (v) => (display_name = v),
      ),
      entryRow(nt("bots.description"), description, (v) => (description = v)),
    );
    const [actions, buttons] = preferencesGroup();
    buttons.append(
      actionRow(t("save"), "", async () => {
        if (!valid()) return;
        bot = await app.api.request<Bot>(path, "PATCH", {
          operation_id: operation(),
          display_name: display_name.trim(),
          description: description.trim(),
          scopes: selected,
        });
        if (valid()) {
          app.profiles.delete(bot.user.id);
          page.replaceChildren();
          await botDetail(app, host, page, bot, reference, all);
        }
      }),
    );
    page.append(identity, fields, scopesGroup(reference, selected), actions);
  } else
    page.append(
      identity,
      actionRow(
        nt("bots.owner", { owner: bot.owner.username }),
        bot.description,
      ),
    );
  const [keys, values] = preferencesGroup(nt("bots.keys"));
  page.append(keys);
  const reload = async () => {
    const list = await app.api.request<BotKeyList>(path + "/keys");
    if (!valid() || !page.isConnected) return;
    values.replaceChildren();
    if (!list.keys.length) values.append(actionRow(nt("bots.no_keys")));
    for (const key of list.keys) {
      const detail = el("details", "bot-key-row");
      detail.append(el("summary", "action-row", key.label + " · …" + key.hint));
      for (const [label, value] of [
        ["bots.key_created", key.created_at],
        ["bots.key_expires", key.expires_at],
        ["bots.key_used", key.last_used_at],
      ])
        detail.append(
          actionRow(
            nt(label!),
            value
              ? new Date(value).toLocaleString()
              : nt(
                  label === "bots.key_expires"
                    ? "bots.key_never"
                    : "bots.key_unused",
                ),
          ),
        );
      detail.append(
        actionRow(nt("bots.key_revoke"), "", () =>
          confirmAction(
            nt("bots.key_revoke_confirm"),
            nt("bots.key_revoke_body"),
            async () => {
              if (!valid()) return;
              await app.api.request(
                path + "/keys/" + segment(key.id),
                "DELETE",
              );
              await reload();
            },
          ),
        ),
      );
      values.append(detail);
    }
  };
  await reload();
  if (!valid()) return;
  if (owner) {
    const [create, form] = preferencesGroup(nt("bots.key_new"));
    let label = "",
      days = "0";
    form.append(
      entryRow(nt("bots.key_label"), label, (v) => (label = v)),
      entryRow(nt("bots.key_days"), days, (v) => (days = v)),
    );
    form.append(
      actionRow(nt("bots.key_create"), "", async () => {
        await recentProof(app);
        if (!valid()) return;
        const expiry = Number(days);
        if (!Number.isInteger(expiry) || expiry < 0 || expiry > 3650)
          throw Error(nt("bots.error_invalid"));
        const created = await app.api.request<BotKeyCreated>(
          path + "/keys",
          "POST",
          {
            operation_id: operation(),
            label: label.trim(),
            ...(expiry ? { expires_in_days: expiry } : {}),
          },
        );
        if (!valid()) return;
        onceSecret(app, valid, nt("bots.key_title"), nt("bots.key_once"), [
          ["", created.key],
          [nt("bots.example"), botExample(created.key)],
        ]);
        if (page.isConnected) await reload();
      }),
    );
    page.append(create);
  }
  const [danger, actions] = preferencesGroup();
  const remove = actionRow(nt("bots.delete"), "", () =>
    confirmAction(
      nt("bots.delete_confirm", { name: bot.user.display_name }),
      nt("bots.delete_body"),
      async () => {
        if (!valid()) return;
        await app.api.request(path, "DELETE");
        if (valid()) host.select("bots");
      },
    ),
  );
  remove.classList.add("destructive");
  actions.append(remove);
  page.append(danger);
}

function botExample(key: string): string {
  const url = location.origin + "/api/v1/rooms/<ROOM_ID>/messages";
  return navigator.platform.startsWith("Win")
    ? `curl.exe -X POST "${url}" -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d "{\\\"operation_id\\\":\\\"hello-1\\\",\\\"text\\\":\\\"Hello\\\"}"`
    : `curl -X POST "${url}" -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" -d '{"operation_id":"hello-1","text":"Hello"}'`;
}
