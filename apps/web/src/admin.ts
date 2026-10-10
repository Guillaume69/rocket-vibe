import { adminDashboard } from "./ui/admin-dashboard";
import { versionParts, newerVersion } from "./admin-format";
import type { App } from "./app";
import type {
  AdminOverview,
  AdminUser,
  AdminUserPage,
  AdminRoomPage,
  AdminReportedMessagePage,
  AdminReportedUserPage,
  EmojiCatalog,
  InstanceIcon,
} from "./protocol";
import { operation, segment } from "./api";
import { button, dialog, el, field, tile, toast } from "./dom";
import { sidebarDialog, preferencesGroup, actionRow } from "./sidebar";
import { language, t } from "./i18n";
import { botBadge } from "./bots";
import { nt } from "./native-i18n";
import { accountFence } from "./preferences-controls";
import type { InstanceSettings } from "./protocol";
import { roomInfo } from "./panel-actions";
import { icon, iconButton } from "./icons";
const label = (en: string, fr: string) => (language === "fr" ? fr : en);
async function latestServerVersion(): Promise<string | undefined> {
  try {
    const response = await fetch(
      "https://api.github.com/repos/Guillaume69/rocket-vibe/releases?per_page=50",
      {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) return;
    const releases: unknown = await response.json();
    if (!Array.isArray(releases)) return;
    let latest: string | undefined;
    for (const release of releases as unknown[]) {
      if (
        !release ||
        typeof release !== "object" ||
        ("draft" in release && release.draft) ||
        ("prerelease" in release && release.prerelease) ||
        !("tag_name" in release) ||
        typeof release.tag_name !== "string" ||
        !release.tag_name.startsWith("server-v") ||
        !versionParts(release.tag_name)
      )
        continue;
      const found = release.tag_name.slice(8);
      if (!latest || newerVersion(found, latest)) latest = found;
    }
    return latest;
  } catch {
    return;
  }
}
export function report(app: App, kind: "messages" | "users", id: string): void {
  const [node, body] = dialog(t("reports"));
  const [wrap, reason] = field(label("Reason", "Motif"));
  reason.maxLength = 1000;
  reason.required = true;
  body.append(
    wrap,
    button(
      t("send"),
      async () => {
        if (!reason.value.trim()) return;
        await app.api.request(
          "/api/v1/" + kind + "/" + segment(id) + "/report",
          "POST",
          { operation_id: operation(), reason: reason.value.trim() },
        );
        node.close();
      },
      "cta",
    ),
  );
}
async function confirm(title: string, run: () => Promise<void>): Promise<void> {
  const [node, body] = dialog(title);
  node.classList.add("alert-dialog");
  body.append(
    el("p", "", title + "?"),
    button(t("cancel"), () => node.close()),
    button(
      t("verify"),
      async () => {
        await run();
        node.close();
      },
      "destructive",
    ),
  );
}
/**
 * The Dashboard's Server icon card: the icon the apps' server rails and this
 * tab show, Change (a PNG or JPEG the server crops to a square) and Remove.
 */
function iconCard(app: App, valid: () => boolean): HTMLElement {
  const [group, rows] = preferencesGroup(nt("admin.icon_title"));
  group.dataset.adminCard = "icon";
  const preview = el("img", "admin-icon-preview");
  preview.alt = "";
  const status = el("span", "action-row-title");
  const row = el("div", "action-row admin-icon-row");
  const text = el("div", "action-row-text");
  text.append(status, el("span", "action-row-subtitle", nt("admin.icon_hint")));
  const picker = el("input");
  picker.type = "file";
  picker.accept = "image/png,image/jpeg";
  picker.hidden = true;
  const change = button(nt("admin.icon_change"), () => picker.click());
  const show = (revision: string | null) => {
    preview.hidden = revision === null;
    if (revision !== null)
      preview.src = "/api/v1/instance/icon?v=" + encodeURIComponent(revision);
    status.textContent = nt(
      revision === null ? "admin.icon_none" : "admin.icon_current",
    );
    remove.hidden = revision === null;
    app.serverIcon(revision);
    if (app.info) app.info.icon_revision = revision;
  };
  const apply = async (file: File | null) => {
    const icon = await app.api.request<InstanceIcon>(
      "/api/v1/admin/icon?operation_id=" + operation(),
      file ? "PUT" : "DELETE",
      file ?? undefined,
    );
    if (!valid()) return;
    show(icon.revision ?? null);
    toast(nt(file ? "admin.icon_saved" : "admin.icon_removed"));
  };
  const remove = button(
    nt("admin.icon_remove"),
    () => {
      const [node, body] = dialog(nt("admin.icon_remove_title"));
      node.classList.add("alert-dialog");
      body.append(
        el("p", "", nt("admin.icon_remove_body")),
        button(t("cancel"), () => node.close()),
        button(
          nt("admin.icon_remove"),
          async () => {
            await apply(null);
            node.close();
          },
          "destructive",
        ),
      );
    },
    "destructive",
  );
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (file) void apply(file).catch(toast);
  });
  row.append(preview, text, change, remove, picker);
  rows.append(row);
  show(app.info?.icon_revision ?? null);
  return group;
}
/** A code the server takes as typed (rv-core's `valid_emoji_code`). */
const emojiCode = /^[a-z0-9_-]{1,80}$/;
/**
 * Custom emoji: the form adding one (name, aliases, image), then the
 * catalogue, each entry deleted after a confirmation. Every change rereads
 * the app's catalogue so pickers and messages follow at once.
 */
async function emojiPage(
  app: App,
  page: HTMLElement,
  valid: () => boolean,
): Promise<void> {
  const [form, formRows] = preferencesGroup(nt("admin.emoji_add"));
  const [nameField, name] = field(nt("admin.emoji_name"));
  const [aliasField, aliases] = field(nt("admin.emoji_aliases"));
  const imageField = el("label", "field");
  const image = el("input");
  image.type = "file";
  image.accept = "image/png,image/jpeg,image/gif";
  imageField.append(
    el("span", "pill-caption", nt("admin.emoji_image")),
    image,
    el("span", "dim", nt("admin.emoji_image_hint")),
  );
  const [list, listRows] = preferencesGroup(nt("admin.cat.emoji"));
  const render = async (catalog?: EmojiCatalog) => {
    catalog ??= await app.api.request<EmojiCatalog>("/api/v1/emoji");
    if (!valid()) return;
    await app.loadEmojis().catch(() => {});
    listRows.replaceChildren();
    if (!catalog.items.length)
      listRows.append(el("p", "dim", nt("admin.emoji_empty")));
    for (const item of catalog.items) {
      const row = actionRow(
        ":" + item.name + ":",
        item.aliases.map((alias) => ":" + alias + ":").join(" "),
      );
      row.classList.add("admin-emoji-row");
      const picture = el("span", "admin-emoji-image");
      app.emoji(item.name, picture);
      row.prepend(picture);
      row.append(
        iconButton("trash", nt("admin.emoji_delete"), () => {
          const [node, body] = dialog(nt("admin.emoji_delete_title"));
          node.classList.add("alert-dialog");
          body.append(
            el(
              "p",
              "",
              nt("admin.emoji_delete_body").replace("{name}", item.name),
            ),
            button(t("cancel"), () => node.close()),
            button(
              nt("admin.emoji_delete"),
              async () => {
                const next = await app.api.request<EmojiCatalog>(
                  "/api/v1/admin/emoji/" +
                    segment(item.name) +
                    "?operation_id=" +
                    operation() +
                    "&expected_revision=" +
                    segment(item.revision),
                  "DELETE",
                );
                node.close();
                await render(next);
              },
              "destructive",
            ),
          );
        }),
      );
      listRows.append(row);
    }
  };
  const add = button(
    nt("admin.emoji_add"),
    async () => {
      const code = name.value.trim().replace(/^:+|:+$/g, "");
      const extra = aliases.value
        .split(",")
        .map((alias) => alias.trim().replace(/^:+|:+$/g, ""))
        .filter(Boolean);
      const file = image.files?.[0];
      const codes = [code, ...extra];
      // Like the other apps' check; a standard emoji's code is the server's
      // refusal (`emoji_name_reserved`), worded from the catalog.
      if (
        !codes.every((c) => emojiCode.test(c)) ||
        new Set(codes).size !== codes.length ||
        extra.length > 8
      )
        throw new Error(nt("admin.emoji_error_name"));
      if (!file) throw new Error(nt("admin.emoji_error_missing"));
      if (file.size > 1024 * 1024)
        throw new Error(nt("admin.emoji_error_size"));
      const next = await app.api.request<EmojiCatalog>(
        "/api/v1/admin/emoji/" +
          segment(code) +
          "?operation_id=" +
          operation() +
          "&aliases=" +
          encodeURIComponent(extra.join(",")),
        "PUT",
        file,
      );
      name.value = aliases.value = image.value = "";
      toast(nt("admin.emoji_added"));
      await render(next);
    },
    "cta",
  );
  formRows.append(nameField, aliasField, imageField, add);
  page.append(el("p", "dim", nt("admin.emoji_hint")), form, list);
  await render();
}
export async function administration(app: App): Promise<void> {
  const host = sidebarDialog(nt("admin.title"), "admin-dialog");
  const valid = accountFence(app);
  let overview = await app.api.request<AdminOverview>("/api/v1/admin/overview");
  let instanceSettings = app.info?.capabilities.bots
    ? await app.api.request<InstanceSettings>("/api/v1/admin/settings")
    : undefined;
  if (!valid()) {
    host.close();
    return;
  }
  const latestVersion = latestServerVersion();
  const textValue = (name: string, value: string | number) => {
    const row = actionRow(name);
    row.append(el("span", "admin-value", String(value)));
    return row;
  };
  const requests = new WeakMap<HTMLElement, number>();
  const dashboard = (page: HTMLElement) => {
    const badge = () => {
      const count = overview.reports.messages + overview.reports.users;
      host.setBadge("moderation", count > 0 ? String(count) : undefined);
    };
    badge();
    adminDashboard(page, {
      overview,
      policy: instanceSettings?.user_bots,
      latest: latestVersion,
      icon: app.info?.capabilities.instance_icon
        ? iconCard(app, valid)
        : undefined,
      valid: () => valid() && host.node.open && page.isConnected,
      refresh: async () => {
        const updated = await app.api.request<AdminOverview>(
          "/api/v1/admin/overview",
        );
        if (valid() && host.node.open && page.isConnected) {
          overview = updated;
          badge();
        }
        return updated;
      },
      updatePolicy: async (on) => {
        if (!valid()) throw Error("Account changed");
        const updated = await app.api.request<InstanceSettings>(
          "/api/v1/admin/settings",
          "PATCH",
          { operation_id: operation(), user_bots: on },
        );
        if (valid() && host.node.open && page.isConnected)
          instanceSettings = updated;
        return updated.user_bots;
      },
      moderation: () => host.select("moderation"),
    });
  };
  async function users(
    page: HTMLElement,
    after = "",
    query = "",
  ): Promise<void> {
    let input = page.querySelector<HTMLInputElement>("input[type=search]");
    if (!input) {
      const [wrap, created] = field(
        label("Search users", "Rechercher des utilisateurs"),
      );
      input = created;
      input.type = "search";
      input.maxLength = 128;
      input.value = query;
      page.append(wrap, el("div", "admin-results"));
      let timer: ReturnType<typeof setTimeout>;
      input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => void users(page, "", created.value).catch(toast),
          250,
        );
      });
    }
    query = input.value;
    const version = (requests.get(page) || 0) + 1;
    requests.set(page, version);
    const params = new URLSearchParams({ q: query });
    if (after) params.set("after", after);
    const value = await app.api.request<AdminUserPage>(
      "/api/v1/admin/users?" + params,
    );
    if (!page.isConnected || requests.get(page) !== version) return;
    const result = page.querySelector<HTMLElement>(".admin-results")!;
    if (!after) result.replaceChildren();
    const [group, rows] = preferencesGroup();
    for (const user of value.items) {
      const row = actionRow(
        user.display_name || user.username,
        "@" + user.username + " · " + user.status,
        () =>
          host.push(user.display_name || user.username, (target) =>
            person(target, user),
          ),
      );
      row.dataset.adminUser = (
        user.username +
        " " +
        user.display_name
      ).toLowerCase();
      const portrait = tile(user.username, "message");
      app.avatar(user, portrait);
      row.prepend(portrait);
      if (user.admin)
        row.insertBefore(
          el(
            "span",
            "admin-badge admin",
            label("Administrator", "Administrateur"),
          ),
          row.lastElementChild,
        );
      if (user.disabled)
        row.insertBefore(
          el(
            "span",
            "admin-badge deactivated",
            label("Deactivated", "Désactivé"),
          ),
          row.lastElementChild,
        );
      if (user.bot) row.insertBefore(botBadge(), row.lastElementChild);
      rows.append(row);
    }
    result.append(group);
    if (value.next)
      result.append(
        button(
          t("older"),
          () => users(page, value.next!, query),
          "preference-more",
        ),
      );
  }
  async function person(page: HTMLElement, user: AdminUser): Promise<void> {
    const [identity, info] = preferencesGroup();
    const row = actionRow(
      user.display_name || user.username,
      "@" + user.username,
    );
    const portrait = tile(user.username, "room");
    app.avatar(user, portrait);
    row.prepend(portrait);
    info.append(row, textValue(label("Presence", "Présence"), user.status));
    if (user.created_at)
      info.append(
        textValue(
          label("Created", "Créé le"),
          new Date(user.created_at).toLocaleDateString(language),
        ),
      );
    if (user.bot) info.append(botBadge());
    page.append(identity);
    if (user.id === app.account?.session.user.id) {
      page.append(
        el("p", "dim", label("This is your account", "C’est votre compte")),
      );
      return;
    }
    const [actions, rows] = preferencesGroup(label("Actions", "Actions"));
    page.append(actions);
    const change = async (input: { disabled?: boolean; admin?: boolean }) => {
      await app.api.request(
        "/api/v1/admin/users/" + segment(user.id),
        "PATCH",
        { operation_id: operation(), revision: user.revision, ...input },
      );
      host.select("users");
    };
    rows.append(
      actionRow(
        user.disabled
          ? label("Activate", "Activer")
          : label("Deactivate", "Désactiver"),
        "",
        () =>
          confirm(user.username, () => change({ disabled: !user.disabled })),
      ),
    );
    if (!user.bot || user.admin)
      rows.append(
        actionRow(
          user.admin
            ? label("Remove administrator", "Retirer le rôle administrateur")
            : label("Make administrator", "Rendre administrateur"),
          "",
          () => confirm(user.username, () => change({ admin: !user.admin })),
        ),
      );
    const remove = actionRow(t("delete"), "", () =>
      confirm(t("delete") + " " + user.username, async () => {
        await app.api.request(
          "/api/v1/admin/users/" + segment(user.id) + "/delete",
          "POST",
          { operation_id: operation(), revision: user.revision },
        );
        host.select("users");
      }),
    );
    remove.classList.add("destructive");
    rows.append(remove);
  }
  async function rooms(
    page: HTMLElement,
    after = "",
    query = "",
  ): Promise<void> {
    let input = page.querySelector<HTMLInputElement>("input[type=search]");
    if (!input) {
      const [wrap, created] = field(
        label("Search rooms", "Rechercher des salons"),
      );
      input = created;
      input.type = "search";
      input.maxLength = 128;
      input.value = query;
      page.append(wrap, el("div", "admin-results"));
      let timer: ReturnType<typeof setTimeout>;
      input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => void rooms(page, "", created.value).catch(toast),
          250,
        );
      });
    }
    query = input.value;
    const version = (requests.get(page) || 0) + 1;
    requests.set(page, version);
    const params = new URLSearchParams({ q: query });
    if (after) params.set("after", after);
    const value = await app.api.request<AdminRoomPage>(
      "/api/v1/admin/rooms?" + params,
    );
    if (!page.isConnected || requests.get(page) !== version) return;
    const result = page.querySelector<HTMLElement>(".admin-results")!;
    if (!after) result.replaceChildren();
    const [group, rows] = preferencesGroup();
    for (const room of value.items) {
      const row = actionRow(
        room.name,
        room.kind +
          " · " +
          room.member_count +
          " " +
          label("members", "membres"),
        () =>
          host.push(room.name, (target) => {
            const [details, values] = preferencesGroup();
            values.append(
              textValue(t("name"), room.name),
              textValue(label("Members", "Membres"), room.member_count),
              textValue("Messages", room.message_count),
            );
            target.append(details);
            if (app.model.rooms.has(room.id))
              target.append(
                actionRow(t("roomInfo"), "", async () => {
                  host.close();
                  await app.openRoom(room.id);
                  await roomInfo(app);
                }),
              );
          }),
      );
      row.dataset.adminRoom = room.name.toLowerCase();
      const roomTile = tile(
        room.name,
        "message",
        room.kind === "private" ? "" : "#",
      );
      if (room.kind === "private") {
        // The GTK admin's locked tile: neutral, a symbolic lock.
        roomTile.classList.add("tile-neutral");
        const lock = icon("lock");
        lock.classList.add("tile-icon");
        roomTile.append(lock);
      }
      row.prepend(roomTile);
      rows.append(row);
    }
    result.append(group);
    if (value.next)
      result.append(
        button(
          t("older"),
          () => rooms(page, value.next!, query),
          "preference-more",
        ),
      );
  }
  async function reports(
    page: HTMLElement,
    kind: "messages" | "users",
    after = "",
  ): Promise<void> {
    const list = page.querySelector<HTMLElement>(".admin-reports")!;
    const path = "/api/v1/admin/reports/" + kind;
    if (!after) list.replaceChildren();
    const add = (
      title: string,
      subtitle: string,
      details: (target: HTMLElement) => void,
    ) => {
      const row = actionRow(title, subtitle, () => host.push(title, details));
      list.append(row);
    };
    if (kind === "messages") {
      const value = await app.api.request<AdminReportedMessagePage>(
        path + (after ? "?after=" + segment(after) : ""),
      );
      for (const item of value.items)
        add(
          item.room_name + " · " + item.author.username,
          item.text,
          (target) => {
            const [group, rows] = preferencesGroup(t("reports"));
            target.append(group);
            rows.append(
              actionRow(
                item.author.display_name || item.author.username,
                item.deleted ? label("Deleted", "Supprimé") : item.text,
              ),
            );
            for (const entry of item.reports)
              rows.append(
                actionRow(
                  entry.reporter.display_name || entry.reporter.username,
                  entry.reason,
                ),
              );
            const [actions, buttons] = preferencesGroup(
              label("Actions", "Actions"),
            );
            target.append(actions);
            buttons.append(
              actionRow(label("Dismiss", "Clore"), "", () =>
                confirm(t("reports"), async () => {
                  await app.api.request(
                    path + "/" + segment(item.message_id) + "/dismiss",
                    "POST",
                    { operation_id: operation() },
                  );
                  host.select("moderation");
                }),
              ),
            );
            const remove = actionRow(t("delete"), "", () =>
              confirm(t("delete"), async () => {
                await app.api.request(
                  path + "/" + segment(item.message_id) + "/delete",
                  "POST",
                  {
                    operation_id: operation(),
                    author_revision: item.author_revision,
                  },
                );
                host.select("moderation");
              }),
            );
            remove.classList.add("destructive");
            buttons.append(remove);
          },
        );
      if (value.next)
        list.append(button(t("older"), () => reports(page, kind, value.next!)));
    } else {
      const value = await app.api.request<AdminReportedUserPage>(
        path + (after ? "?after=" + segment(after) : ""),
      );
      for (const item of value.items)
        add(
          item.user.display_name || item.user.username,
          "@" + item.user.username,
          (target) => {
            const [group, rows] = preferencesGroup(t("reports"));
            for (const entry of item.reports)
              rows.append(
                actionRow(
                  entry.reporter.display_name || entry.reporter.username,
                  entry.reason,
                ),
              );
            target.append(
              group,
              actionRow(label("Dismiss", "Clore"), "", () =>
                confirm(t("reports"), async () => {
                  await app.api.request(
                    path + "/" + segment(item.user.id) + "/dismiss",
                    "POST",
                    { operation_id: operation() },
                  );
                  host.select("moderation");
                }),
              ),
            );
          },
        );
      if (value.next)
        list.append(button(t("older"), () => reports(page, kind, value.next!)));
    }
    if (!list.children.length) list.append(el("p", "dim", t("noResults")));
  }
  host.add("dashboard", nt("admin.cat.dashboard"), "admin", dashboard);
  host.add("moderation", nt("admin.cat.moderation"), "moderation", (page) => {
    const tabs = el("div", "tabs"),
      list = el("div", "admin-reports preferences-box");
    tabs.append(
      button(label("Reported messages", "Messages signalés"), () =>
        reports(page, "messages"),
      ),
      button(label("Reported users", "Personnes signalées"), () =>
        reports(page, "users"),
      ),
    );
    page.append(tabs, list);
    return reports(page, "messages");
  });
  host.add("rooms", nt("admin.cat.rooms"), "rooms", (page) => rooms(page));
  host.add("users", nt("admin.cat.users"), "users", (page) => users(page));
  if (app.info?.capabilities.custom_emoji_admin)
    host.add("emoji", nt("admin.cat.emoji"), "smile", (page) =>
      emojiPage(app, page, valid),
    );
  host.select("dashboard");
}
