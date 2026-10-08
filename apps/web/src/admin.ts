import type { App } from "./app";
import type {
  AdminOverview,
  AdminUser,
  AdminUserPage,
  AdminRoomPage,
  AdminReportedMessagePage,
  AdminReportedUserPage,
} from "./protocol";
import { operation, segment } from "./api";
import { button, dialog, el, field, tile, toast } from "./dom";
import { sidebarDialog, preferencesGroup, actionRow } from "./sidebar";
import { language, t } from "./i18n";
import { roomInfo } from "./panels";
const label = (en: string, fr: string) => (language === "fr" ? fr : en);
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
export async function administration(app: App): Promise<void> {
  const host = sidebarDialog(t("admin"), "admin-dialog");
  let overview = await app.api.request<AdminOverview>("/api/v1/admin/overview");
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
    const add = (title: string, values: [string, string | number][]) => {
      const [group, rows] = preferencesGroup(title);
      for (const [name, value] of values) rows.append(textValue(name, value));
      columns[nextCard++ % columns.length].append(group);
    };
    add(label("Deployment", "Déploiement"), [
      ["RocketVibe", overview.server_version],
      ["PostgreSQL", overview.postgres_version],
      [
        label("Started", "Démarrage"),
        new Date(overview.started_at).toLocaleString(language),
      ],
    ]);
    add(t("people"), [
      [label("Total", "Total"), overview.users.total],
      [label("Active", "Actifs"), overview.users.active],
      [label("Online", "En ligne"), overview.users.online],
      [label("Administrators", "Administrateurs"), overview.users.admins],
      [label("Deactivated", "Désactivés"), overview.users.deactivated],
    ]);
    add(t("rooms"), [
      [label("Total", "Total"), overview.rooms.total],
      [label("Public", "Publics"), overview.rooms.public],
      [t("private"), overview.rooms.private],
      [label("Direct", "Directs"), overview.rooms.direct],
      [t("encrypted"), overview.rooms.encrypted],
    ]);
    add("Messages", [
      [label("Total", "Total"), overview.messages.total],
      [label("Public", "Publics"), overview.messages.public],
      [t("private"), overview.messages.private],
      [label("Direct", "Directs"), overview.messages.direct],
    ]);
    add(label("Uploads", "Fichiers"), [
      [label("Files", "Fichiers"), overview.uploads.count],
      [
        label("Size", "Taille"),
        (overview.uploads.bytes / 1024 / 1024).toLocaleString(language, {
          maximumFractionDigits: 1,
        }) + " MiB",
      ],
    ]);
    add(t("reports"), [
      ["Messages", overview.reports.messages],
      [t("people"), overview.reports.users],
    ]);
    page.append(
      button(
        label("Refresh", "Actualiser"),
        async () => {
          overview = await app.api.request<AdminOverview>(
            "/api/v1/admin/overview",
          );
          page.replaceChildren();
          dashboard(page);
        },
        "admin-refresh",
      ),
      cards,
    );
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
  host.add(
    "dashboard",
    label("Dashboard", "Tableau de bord"),
    "admin",
    dashboard,
  );
  host.add(
    "moderation",
    label("Moderation", "Modération"),
    "moderation",
    (page) => {
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
    },
  );
  host.add("rooms", t("rooms"), "rooms", (page) => rooms(page));
  host.add("users", label("Users", "Utilisateurs"), "users", (page) =>
    users(page),
  );
  host.select("dashboard");
}
