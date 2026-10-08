import type { App } from "./app";
import type {
  AdminOverview,
  AdminUserPage,
  AdminRoomPage,
  AdminReportedMessagePage,
  AdminReportedUserPage,
} from "./protocol";
import { operation, segment } from "./api";
import { button, dialog, el, field, tile } from "./dom";
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
export async function administration(
  app: App,
  page: HTMLElement,
): Promise<void> {
  const overview = await app.api.request<AdminOverview>(
    "/api/v1/admin/overview",
  );
  const grid = el("div", "stats");
  for (const [name, count] of [
    [t("people"), overview.users.total],
    [t("rooms"), overview.rooms.total],
    ["Messages", overview.messages.total],
    ["Uploads", overview.uploads.count],
    [t("reports"), overview.reports.messages + overview.reports.users],
  ])
    grid.append(el("div", "stat", name + " · " + count));
  const tabs = el("div", "tabs"),
    list = el("div");
  page.append(
    el(
      "p",
      "dim",
      "RocketVibe " +
        overview.server_version +
        " · PostgreSQL " +
        overview.postgres_version,
    ),
    grid,
    tabs,
    list,
  );
  async function users(after = ""): Promise<void> {
    const value = await app.api.request<AdminUserPage>(
      "/api/v1/admin/users" + (after ? "?after=" + segment(after) : ""),
    );
    if (!after) list.replaceChildren();
    for (const user of value.items) {
      const row = el("div", "preference-row");
      row.append(
        tile(user.username),
        el("span", "", user.display_name || user.username),
        el(
          "span",
          "dim",
          user.disabled
            ? label("Deactivated", "Désactivé")
            : user.admin
              ? label("Administrator", "Administrateur")
              : t("profile"),
        ),
      );
      if (user.id !== app.account?.session.user.id) {
        const actions = el("div", "admin-actions");
        const change = async (input: {
          disabled?: boolean;
          admin?: boolean;
        }) => {
          await app.api.request(
            "/api/v1/admin/users/" + segment(user.id),
            "PATCH",
            { operation_id: operation(), revision: user.revision, ...input },
          );
          await users();
        };
        actions.append(
          button(
            user.disabled
              ? label("Activate", "Activer")
              : label("Deactivate", "Désactiver"),
            () =>
              confirm(user.username, () =>
                change({ disabled: !user.disabled }),
              ),
          ),
          button(
            user.admin
              ? label("Remove administrator", "Retirer le rôle administrateur")
              : label("Make administrator", "Rendre administrateur"),
            () => confirm(user.username, () => change({ admin: !user.admin })),
          ),
          button(
            t("delete"),
            () =>
              confirm(t("delete") + " " + user.username, async () => {
                await app.api.request(
                  "/api/v1/admin/users/" + segment(user.id) + "/delete",
                  "POST",
                  { operation_id: operation(), revision: user.revision },
                );
                await users();
              }),
            "destructive",
          ),
        );
        row.append(actions);
      }
      list.append(row);
    }
    if (value.next) list.append(button(t("older"), () => users(value.next!)));
  }
  async function rooms(after = ""): Promise<void> {
    const value = await app.api.request<AdminRoomPage>(
      "/api/v1/admin/rooms" + (after ? "?after=" + segment(after) : ""),
    );
    if (!after) list.replaceChildren();
    for (const room of value.items) {
      const row = el("div", "preference-row");
      row.append(
        el("span", "", room.name + " · " + room.member_count),
        el("span", "dim", room.kind),
      );
      if (app.model.rooms.has(room.id))
        row.append(
          button(t("roomInfo"), async () => {
            await app.openRoom(room.id);
            await roomInfo(app);
          }),
        );
      list.append(row);
    }
    if (value.next) list.append(button(t("older"), () => rooms(value.next!)));
  }
  async function reports(
    kind: "messages" | "users",
    after = "",
  ): Promise<void> {
    if (!after) list.replaceChildren();
    const path = "/api/v1/admin/reports/" + kind;
    if (kind === "messages") {
      const value = await app.api.request<AdminReportedMessagePage>(
        path + (after ? "?after=" + segment(after) : ""),
      );
      for (const item of value.items) {
        const card = el("div", "file-card");
        card.append(
          el("strong", "", item.room_name + " · " + item.author.username),
          el(
            "p",
            "message-body",
            item.deleted ? label("Deleted", "Supprimé") : item.text,
          ),
        );
        for (const report of item.reports)
          card.append(el("p", "dim", report.reason));
        card.append(
          button(label("Dismiss", "Clore"), () =>
            confirm(t("reports"), async () => {
              await app.api.request(
                path + "/" + segment(item.message_id) + "/dismiss",
                "POST",
                { operation_id: operation() },
              );
              await reports(kind);
            }),
          ),
          button(
            t("delete"),
            () =>
              confirm(t("delete"), async () => {
                await app.api.request(
                  path + "/" + segment(item.message_id) + "/delete",
                  "POST",
                  { operation_id: operation() },
                );
                await reports(kind);
              }),
            "destructive",
          ),
        );
        list.append(card);
      }
      if (value.next)
        list.append(button(t("older"), () => reports(kind, value.next!)));
    } else {
      const value = await app.api.request<AdminReportedUserPage>(
        path + (after ? "?after=" + segment(after) : ""),
      );
      for (const item of value.items) {
        const card = el("div", "file-card");
        card.append(
          el("strong", "", item.user.display_name || item.user.username),
        );
        for (const report of item.reports)
          card.append(el("p", "dim", report.reason));
        card.append(
          button(label("Dismiss", "Clore"), () =>
            confirm(t("reports"), async () => {
              await app.api.request(
                path + "/" + segment(item.user.id) + "/dismiss",
                "POST",
                { operation_id: operation() },
              );
              await reports(kind);
            }),
          ),
        );
        list.append(card);
      }
      if (value.next)
        list.append(button(t("older"), () => reports(kind, value.next!)));
    }
    if (!list.children.length) list.append(el("p", "dim", t("noResults")));
  }
  tabs.append(
    button(t("people"), () => users()),
    button(t("rooms"), () => rooms()),
    button(t("reports"), () => reports("messages")),
    button(t("profile"), () => reports("users")),
  );
  await users();
}
