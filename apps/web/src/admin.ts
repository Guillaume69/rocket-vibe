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
import { switchRow, accountFence } from "./preferences-controls";
import type { InstanceSettings } from "./protocol";
import { roomInfo } from "./panels";
import { iconButton } from "./icons";
const label = (en: string, fr: string) => (language === "fr" ? fr : en);
function versionParts(text: string): bigint[] | undefined {
  const match = /^(?:server-v|v)?(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return match?.slice(1).map(BigInt);
}
function newerVersion(latest: string, current: string): boolean {
  const a = versionParts(latest),
    b = versionParts(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}
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
function uptime(started: string): string | undefined {
  const seconds = Math.floor((Date.now() - Date.parse(started)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const d = Math.floor(seconds / 86400),
    h = Math.floor((seconds % 86400) / 3600),
    m = Math.floor((seconds % 3600) / 60);
  return d
    ? nt("admin.days", { d, h })
    : h
      ? nt("admin.hours", { h, m })
      : nt("admin.minutes", { m });
}
function uploadSize(bytes: number): string {
  // GLib uses the system locale for sizes, independently of the UI language.
  const locale = navigator.language || language;
  const french = locale.startsWith("fr");
  if (bytes < 1000)
    return (
      new Intl.NumberFormat(locale).format(bytes) +
      " " +
      (french
        ? bytes === 1
          ? "octet"
          : "octets"
        : bytes === 1
          ? "byte"
          : "bytes")
    );
  const units = french
    ? ["ko", "Mo", "Go", "To", "Po", "Eo"]
    : ["kB", "MB", "GB", "TB", "PB", "EB"];
  let value = bytes / 1000,
    unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return (
    value.toLocaleString(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }) +
    " " +
    units[unit]
  );
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
      const code = name.value.trim().replace(/^:|:$/g, "");
      const extra = aliases.value
        .split(",")
        .map((alias) => alias.trim().replace(/^:|:$/g, ""))
        .filter(Boolean);
      const file = image.files?.[0];
      if (![code, ...extra].every((c) => emojiCode.test(c)) || extra.length > 8)
        throw new Error(nt("admin.emoji_error_name"));
      if (!file) throw new Error(nt("admin.emoji_image"));
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
    page.classList.add("admin-dashboard-page");
    const cards = el("div", "admin-cards");
    const columns = [
      el("div", "admin-card-column"),
      el("div", "admin-card-column"),
    ];
    cards.append(...columns);
    let nextCard = 0;
    const add = (
      title: string,
      values: [string, string | number][],
      id: string,
    ) => {
      const [group, rows] = preferencesGroup(title);
      group.dataset.adminCard = id;
      for (const [name, value] of values) rows.append(textValue(name, value));
      columns[nextCard++ % columns.length].append(group);
      return { group, rows };
    };
    const deployment = add(nt("admin.deployment"), [], "deployment");
    const refresh = iconButton(
      "refresh",
      nt("admin.refresh_figures"),
      async () => {
        const updated = await app.api.request<AdminOverview>(
          "/api/v1/admin/overview",
        );
        if (!valid() || !page.isConnected) return;
        overview = updated;
        page.replaceChildren();
        dashboard(page);
      },
      "flat admin-refresh",
    );
    deployment.group.querySelector("h3")!.append(refresh);
    const version = textValue(nt("admin.version"), overview.server_version);
    deployment.rows.append(version);
    void latestVersion.then((latest) => {
      if (!latest || !valid() || !version.isConnected) return;
      const available = newerVersion(latest, overview.server_version);
      version.append(
        el(
          "span",
          "admin-update" + (available ? " available" : ""),
          available
            ? nt("admin.update_available", { version: latest })
            : nt("admin.up_to_date"),
        ),
      );
    });
    const elapsed = uptime(overview.started_at);
    if (elapsed !== undefined)
      deployment.rows.append(textValue(nt("admin.uptime"), elapsed));
    deployment.rows.append(
      textValue(
        nt("admin.database"),
        "PostgreSQL " + overview.postgres_version,
      ),
    );
    if (overview.migration_version)
      deployment.rows.append(
        textValue(nt("admin.migration"), overview.migration_version),
      );
    const instance = textValue(
      nt("admin.instance"),
      overview.instance_id.length > 12
        ? overview.instance_id.slice(0, 12) + "…"
        : overview.instance_id,
    );
    instance.querySelector<HTMLElement>(".admin-value")!.title =
      overview.instance_id;
    instance.append(
      iconButton(
        "copy",
        nt("actions.copy"),
        () => navigator.clipboard.writeText(overview.instance_id),
        "flat admin-copy",
      ),
    );
    deployment.rows.append(instance);
    const users = add(
      nt("admin.cat.users"),
      [
        [nt("admin.total"), overview.users.total],
        [nt("admin.active"), overview.users.active],
        [nt("admin.deactivated"), overview.users.deactivated],
        [nt("admin.admins"), overview.users.admins],
      ],
      "users",
    );
    for (const presence of ["online", "away", "busy", "offline"] as const) {
      const row = textValue(
        nt("presence." + presence),
        overview.users[presence],
      );
      const dot = el("span", "presence " + presence);
      dot.title = nt("presence." + presence);
      row.prepend(dot);
      users.rows.append(row);
    }
    const kinds = (title: string, values: AdminOverview["rooms"], id: string) =>
      add(
        title,
        [
          [nt("admin.total"), values.total],
          [nt("admin.public"), values.public],
          [nt("admin.private"), values.private],
          [nt("admin.direct"), values.direct],
          [nt("admin.encrypted"), values.encrypted],
        ],
        id,
      );
    kinds(nt("admin.cat.rooms"), overview.rooms, "rooms");
    kinds(nt("admin.messages"), overview.messages, "messages");
    add(
      nt("admin.uploads"),
      [
        [nt("admin.uploads_count"), overview.uploads.count],
        [nt("admin.uploads_size"), uploadSize(overview.uploads.bytes)],
      ],
      "uploads",
    );
    const reports = add(
      nt("admin.reports"),
      [
        [nt("admin.reported_messages"), overview.reports.messages],
        [nt("admin.reported_users"), overview.reports.users],
      ],
      "reports",
    );
    const moderation = actionRow(nt("admin.open_moderation"), "", () =>
      host.select("moderation"),
    );
    moderation.classList.add("admin-open-moderation");
    reports.rows.append(moderation);
    const reportCount = overview.reports.messages + overview.reports.users;
    host.setBadge(
      "moderation",
      reportCount > 0 ? String(reportCount) : undefined,
    );
    if (instanceSettings) {
      const [group, rows] = preferencesGroup(nt("admin.bots"));
      const toggle = switchRow(
        nt("admin.user_bots"),
        instanceSettings.user_bots,
        (on) => {
          void (async () => {
            if (!valid() || !toggle.isConnected) return;
            const input = toggle.querySelector<HTMLInputElement>("input")!;
            const previous = instanceSettings!.user_bots;
            input.disabled = true;
            try {
              const updated = await app.api.request<InstanceSettings>(
                "/api/v1/admin/settings",
                "PATCH",
                { operation_id: operation(), user_bots: on },
              );
              if (!valid() || !toggle.isConnected) return;
              instanceSettings = updated;
              input.checked = updated.user_bots;
            } catch (error) {
              if (valid() && toggle.isConnected) input.checked = previous;
              throw error;
            } finally {
              if (valid() && toggle.isConnected) input.disabled = false;
            }
          })().catch(toast);
        },
      );
      const policyInput = toggle.querySelector<HTMLInputElement>("input")!;
      policyInput.classList.add("row-switch");
      policyInput.setAttribute("role", "switch");
      const text = el("div", "action-row-text");
      text.append(
        toggle.querySelector(".action-row-title")!,
        el("span", "action-row-subtitle", nt("admin.user_bots_hint")),
      );
      toggle.prepend(text);
      rows.append(toggle);
      group.dataset.adminCard = "bots";
      columns[nextCard++ % columns.length].append(group);
    }
    if (app.info?.capabilities.instance_icon) {
      const group = iconCard(app, valid);
      columns[nextCard++ % columns.length].append(group);
    }
    page.append(cards);
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
      row.prepend(
        tile(room.name, "message", room.kind === "private" ? "🔒" : "#"),
      );
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
