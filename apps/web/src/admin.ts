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
  AccountInvitation,
  IssuedAccountInvitation,
  CreateAccountInvitation,
} from "./protocol";
import { operation, segment, secret } from "./api";
import { button, dialog, el, field, tile, toast } from "./dom";
import {
  sidebarDialog,
  preferencesGroup,
  actionRow,
  type SidebarHost,
} from "./sidebar";
import { language, t } from "./i18n";
import { botBadge } from "./bots";
import { nt } from "./native-i18n";
import { accountFence, confirmAction } from "./preferences-controls";
import type { InstanceSettings } from "./protocol";
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
        !release.tag_name.startsWith("vibez-v") ||
        !versionParts(release.tag_name)
      )
        continue;
      const found = release.tag_name.slice("vibez-v".length);
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
      confirmAction(
        nt("admin.icon_remove_title"),
        nt("admin.icon_remove_body"),
        () => apply(null),
        nt("admin.icon_remove"),
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
  host: SidebarHost,
): Promise<void> {
  page.classList.add("admin-emoji-list");
  const current = () => valid() && host.node.open;
  const [list, listRows] = preferencesGroup(
    nt("admin.cat.emoji"),
    nt("admin.emoji_hint"),
  );
  const render = async (catalog?: EmojiCatalog) => {
    catalog ??= await app.api.request<EmojiCatalog>("/api/v1/emoji");
    if (!current()) return;
    await app.loadEmojis().catch(() => {});
    if (!current()) return;
    listRows.replaceChildren();
    if (!catalog.items.length)
      listRows.append(actionRow(nt("admin.emoji_empty")));
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
          confirmAction(
            nt("admin.emoji_delete_title"),
            nt("admin.emoji_delete_body", { name: item.name }),
            async () => {
              if (!current()) return;
              const next = await app.api.request<EmojiCatalog>(
                "/api/v1/admin/emoji/" +
                  segment(item.name) +
                  "?operation_id=" +
                  operation() +
                  "&expected_revision=" +
                  segment(item.revision),
                "DELETE",
              );
              await render(next);
            },
            nt("admin.emoji_delete"),
          );
        }),
      );
      listRows.append(row);
    }
  };
  const addForm = () =>
    host.push(nt("admin.emoji_add"), (target) => {
      target.classList.add("admin-emoji-form");
      const active = () => current() && target.isConnected;
      const [form, formRows] = preferencesGroup();
      const [nameField, name] = field(nt("admin.emoji_name"));
      const [aliasField, aliases] = field(nt("admin.emoji_aliases"));
      const imageRow = actionRow(
        nt("admin.emoji_image"),
        nt("admin.emoji_image_hint"),
      );
      imageRow.classList.add("admin-emoji-image-row");
      const preview = el("img", "admin-emoji-image");
      preview.alt = "";
      preview.hidden = true;
      const image = el("input");
      image.type = "file";
      image.accept = "image/png,image/jpeg,image/gif";
      image.hidden = true;
      image.setAttribute("aria-label", nt("admin.emoji_choose"));
      const choose = button(
        nt("admin.emoji_choose"),
        () => image.click(),
        "admin-emoji-choose",
      );
      imageRow.prepend(preview);
      imageRow.append(choose, image);
      let selected: File | undefined;
      const [actions, actionRows] = preferencesGroup();
      actions.classList.add("admin-emoji-actions");
      const submit = button(
        nt("admin.emoji_add"),
        async () => {
          if (!active()) return;
          const code = name.value.trim().replace(/^:+|:+$/g, "");
          const extra = aliases.value
            .split(",")
            .map((alias) => alias.trim().replace(/^:+|:+$/g, ""))
            .filter(Boolean);
          const file = selected;
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
          if (!active()) return;
          toast(nt("admin.emoji_added"));
          await render(next);
          if (active()) host.pop();
        },
        "suggested-action pill admin-emoji-submit",
      );
      const ready = () => {
        submit.disabled = !name.value.trim() || !selected;
      };
      name.addEventListener("input", ready);
      image.addEventListener("change", () => {
        const file = image.files?.[0];
        image.value = "";
        if (!file || !active()) return;
        if (file.size > 1024 * 1024) {
          toast(nt("admin.emoji_error_size"));
          return;
        }
        selected = file;
        imageRow.querySelector(".action-row-subtitle")!.textContent = file.name;
        const reader = new FileReader();
        reader.addEventListener("load", () => {
          if (
            !active() ||
            selected !== file ||
            typeof reader.result !== "string"
          )
            return;
          preview.src = reader.result;
          preview.hidden = false;
        });
        reader.readAsDataURL(file);
        ready();
      });
      ready();
      formRows.append(nameField, aliasField, imageRow);
      actionRows.append(submit);
      target.append(form, actions);
    });
  const header = el("div", "preferences-group-header");
  header.append(
    list.querySelector("h3")!,
    iconButton("plus", nt("admin.emoji_add"), addForm),
  );
  header.querySelector("button")!.classList.add("admin-emoji-add");
  list.prepend(header);
  page.append(list);
  await render();
}
async function invitationPage(
  app: App,
  page: HTMLElement,
  valid: () => boolean,
): Promise<void> {
  const current = () => valid() && page.isConnected;
  page.classList.add("admin-invitations");
  const [form, controls] = preferencesGroup(
    nt("admin.cat.invitations"),
    nt("admin.invitation_hint"),
  );
  const [list, listRows] = preferencesGroup();
  list.classList.add("admin-invitation-list");
  const output = el("div", "admin-invitation-output");
  let pending: CreateAccountInvitation | undefined,
    reading = 0;
  const reload = async () => {
    const expected = ++reading;
    const rows = await app.api.request<AccountInvitation[]>(
      "/api/v1/admin/invitations",
    );
    if (!current() || expected !== reading) return;
    listRows.replaceChildren();
    if (!rows.length) listRows.append(actionRow(nt("admin.invitation_empty")));
    for (const item of rows) {
      const status = item.revoked_at
        ? "revoked"
        : item.consumed_at
          ? "used"
          : Date.parse(item.expires_at) <= Date.now()
            ? "expired"
            : "active";
      const row = actionRow(
        item.id,
        nt("admin.invitation_" + status) +
          " · " +
          new Date(item.expires_at).toLocaleString(),
      );
      row.dataset.invitationId = item.id;
      if (status === "active")
        row.append(
          button(
            nt("admin.invitation_revoke"),
            () =>
              confirmAction(
                nt("admin.invitation_revoke"),
                nt("admin.invitation_revoke_body"),
                async () => {
                  if (!current()) return;
                  await app.api.request(
                    "/api/v1/admin/invitations/" + segment(item.id) + "/revoke",
                    "POST",
                    { operation_id: operation() },
                  );
                  if (current()) {
                    output.replaceChildren();
                    await reload();
                  }
                },
              ),
            "destructive",
          ),
        );
      listRows.append(row);
    }
  };
  controls.append(
    button(
      nt("admin.invitation_create"),
      async () => {
        if (!current()) return;
        pending ??= { operation_id: operation(), hours: 168, token: secret() };
        const issued = await app.api.request<IssuedAccountInvitation>(
          "/api/v1/admin/invitations",
          "POST",
          pending,
        );
        pending = undefined;
        if (!current()) return;
        const [codeRow, code] = field(nt("login.invitation"));
        code.value = issued.token;
        code.readOnly = true;
        code.classList.add("admin-invitation-code");
        code.setAttribute("aria-label", nt("admin.invitation_code"));
        output.replaceChildren(
          actionRow(nt("admin.invitation_secret")),
          codeRow,
          button(
            nt("admin.invitation_copy"),
            async () => {
              await navigator.clipboard.writeText(issued.token);
              toast(nt("actions.copy"));
            },
            "admin-invitation-copy",
          ),
        );
        await reload();
      },
      "suggested-action admin-invitation-create",
    ),
    output,
  );
  const header = el("div", "preferences-group-header");
  header.append(
    button(nt("admin.invitation_refresh"), reload, "admin-invitation-refresh"),
  );
  list.prepend(header);
  page.closest("dialog")?.addEventListener(
    "close",
    () => {
      const code = output.querySelector<HTMLInputElement>("input");
      if (code) code.value = "";
      output.replaceChildren();
      pending = undefined;
    },
    { once: true },
  );
  page.append(form, list);
  await reload();
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
      valid: () => valid() && host.node.open,
      refresh: async () => {
        const updated = await app.api.request<AdminOverview>(
          "/api/v1/admin/overview",
        );
        if (valid() && host.node.open) {
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
        if (valid() && host.node.open) instanceSettings = updated;
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
    if (!valid() || !host.node.open || requests.get(page) !== version) return;
    const result = page.querySelector<HTMLElement>(".admin-results")!;
    if (!after) result.replaceChildren();
    const [group, rows] = preferencesGroup();
    for (const user of value.items) {
      const row = actionRow(
        user.display_name || user.username,
        "@" +
          user.username +
          " · " +
          nt("presence." + user.status) +
          (user.last_seen_at
            ? " · " +
              nt("admin.last_seen", {
                date: new Date(user.last_seen_at).toLocaleDateString(language),
              })
            : ""),
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
      portrait.classList.add("admin-person-avatar");
      portrait.append(el("span", "presence presence-badge " + user.status));
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
    if (!value.items.length && !after)
      rows.append(actionRow(nt("admin.empty")));
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
      if (!valid() || !host.node.open || !page.isConnected) return;
      await app.api.request(
        "/api/v1/admin/users/" + segment(user.id),
        "PATCH",
        { operation_id: operation(), revision: user.revision, ...input },
      );
      if (valid() && host.node.open && page.isConnected)
        host.select("users", true);
    };
    rows.append(
      actionRow(
        nt(user.disabled ? "admin.activate" : "admin.deactivate"),
        "",
        () =>
          user.disabled
            ? change({ disabled: false })
            : confirmAction(
                nt("admin.deactivate"),
                nt("admin.deactivate_body"),
                () => change({ disabled: true }),
              ),
      ),
    );
    if (!user.bot || user.admin)
      rows.append(
        actionRow(
          nt(user.admin ? "admin.remove_admin" : "admin.make_admin"),
          "",
          () => change({ admin: !user.admin }),
        ),
      );
    const remove = actionRow(nt("admin.delete_user"), "", () =>
      confirmAction(
        nt("admin.delete_user"),
        nt("admin.delete_user_body_vibez"),
        async () => {
          if (!valid() || !host.node.open || !page.isConnected) return;
          await app.api.request(
            "/api/v1/admin/users/" + segment(user.id) + "/delete",
            "POST",
            { operation_id: operation(), revision: user.revision },
          );
          if (valid() && host.node.open && page.isConnected)
            host.select("users", true);
        },
        nt("actions.delete"),
      ),
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
    if (!valid() || !host.node.open || requests.get(page) !== version) return;
    const result = page.querySelector<HTMLElement>(".admin-results")!;
    if (!after) result.replaceChildren();
    const [group, rows] = preferencesGroup();
    for (const room of value.items) {
      const row = actionRow(
        room.name,
        [
          nt("admin.members", { n: room.member_count }),
          nt("admin.message_count", { n: room.message_count }),
          ...(room.created_at
            ? [
                nt("admin.created", {
                  date: new Date(room.created_at).toLocaleDateString(language),
                }),
              ]
            : []),
        ].join(" · "),
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
      if (room.read_only)
        row.append(
          el("span", "admin-badge read-only", nt("admin.badge_read_only")),
        );
      if (room.encrypted)
        row.append(
          el("span", "admin-badge encrypted", nt("admin.badge_encrypted")),
        );
      rows.append(row);
    }
    if (!value.items.length && !after)
      rows.append(actionRow(nt("admin.empty")));
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
    const list = page.querySelector<HTMLElement>(
      '.admin-reports[data-report-kind="' + kind + '"]',
    )!;
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
              actionRow(nt("admin.dismiss"), "", async () => {
                if (!valid() || !host.node.open || !target.isConnected) return;
                await app.api.request(
                  path + "/" + segment(item.message_id) + "/dismiss",
                  "POST",
                  { operation_id: operation() },
                );
                if (valid() && host.node.open && target.isConnected)
                  host.select("moderation", true);
              }),
            );
            const remove = actionRow(nt("admin.delete_message"), "", () =>
              confirmAction(
                nt("admin.delete_message"),
                nt("admin.delete_message_body"),
                async () => {
                  if (!valid() || !host.node.open || !target.isConnected)
                    return;
                  await app.api.request(
                    path + "/" + segment(item.message_id) + "/delete",
                    "POST",
                    {
                      operation_id: operation(),
                      author_revision: item.author_revision,
                    },
                  );
                  if (valid() && host.node.open && target.isConnected)
                    host.select("moderation", true);
                },
                nt("actions.delete"),
              ),
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
              actionRow(nt("admin.dismiss"), "", async () => {
                if (!valid() || !host.node.open || !target.isConnected) return;
                await app.api.request(
                  path + "/" + segment(item.user.id) + "/dismiss",
                  "POST",
                  { operation_id: operation() },
                );
                if (valid() && host.node.open && target.isConnected)
                  host.select("moderation", true);
              }),
            );
          },
        );
      if (value.next)
        list.append(button(t("older"), () => reports(page, kind, value.next!)));
    }
    if (!list.children.length)
      list.append(actionRow(nt("admin.nothing_reported")));
  }
  host.add("dashboard", nt("admin.cat.dashboard"), "admin", dashboard);
  host.add(
    "moderation",
    nt("admin.cat.moderation"),
    "moderation",
    async (page) => {
      for (const kind of ["messages", "users"] as const) {
        const [group, list] = preferencesGroup(
          nt(
            kind === "messages"
              ? "admin.reported_messages"
              : "admin.reported_users",
          ),
        );
        list.classList.add("admin-reports");
        list.dataset.reportKind = kind;
        page.append(group);
      }
      await Promise.all([reports(page, "messages"), reports(page, "users")]);
    },
  );
  host.add("rooms", nt("admin.cat.rooms"), "rooms", (page) => rooms(page));
  host.add("users", nt("admin.cat.users"), "users", (page) => users(page));
  if (app.info?.capabilities.admin_invitations)
    host.add("invitations", nt("admin.cat.invitations"), "users", (page) =>
      invitationPage(app, page, valid),
    );
  if (app.info?.capabilities.custom_emoji_admin)
    host.add("emoji", nt("admin.cat.emoji"), "smile", (page) =>
      emojiPage(app, page, valid, host),
    );
  host.select("dashboard");
}
