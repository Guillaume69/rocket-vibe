import type { App } from "./app";
import type {
  Message,
  WorkflowForm,
  FormAnswer,
  RoomMemberPage,
  User,
} from "./protocol";
import { el, button, dialog } from "./dom";
import { operation, segment } from "./api";
import { nt } from "./native-i18n";
import { t } from "./i18n";
import { preferencesGroup } from "./sidebar";
import {
  accountFence,
  entryRow,
  selectRow,
  switchRow,
} from "./preferences-controls";
export function formCard(
  message: Message,
  me: string,
  answer: (message: Message) => Promise<void>,
): HTMLElement {
  const form = message.form!;
  const card = el("div", "card workflow-form-card");
  card.append(
    el("strong", "workflow-form-title", form.title),
    el(
      "span",
      "dim",
      form.recipient
        ? nt("workflows.form_for", { user: form.recipient.username })
        : nt("workflows.form_anyone"),
    ),
  );
  if (form.answered_by)
    card.append(
      el(
        "span",
        "workflow-form-answered",
        nt("workflows.form_answered_by", {
          name: form.answered_by.display_name || form.answered_by.username,
        }),
      ),
    );
  else if (new Date(form.expires_at).getTime() <= Date.now())
    card.append(el("span", "dim", nt("workflows.form_expired")));
  else if (!form.recipient || form.recipient.id === me)
    card.append(
      button(
        nt("workflows.form_answer"),
        () => answer(message),
        "cta workflow-form-answer",
      ),
    );
  return card;
}
export async function answerForm(app: App, message: Message): Promise<void> {
  if (
    !message.form ||
    !app.model.rooms.has(message.room_id) ||
    app.model.rooms.get(message.room_id)?.encrypted
  )
    return;
  const valid = accountFence(app),
    membership = app.model.rooms.get(message.room_id)?.read_state
      ?.membership_version;
  const current = () =>
    valid() &&
    app.model.rooms.has(message.room_id) &&
    app.model.rooms.get(message.room_id)?.read_state?.membership_version ===
      membership &&
    !!app.model.messages.get(message.id)?.form;
  const form: WorkflowForm = message.form;
  const [node, body] = dialog(form.title);
  node.classList.add("workflow-form-dialog");
  const answers: Record<string, FormAnswer> = {};
  const [group, rows] = preferencesGroup();
  body.append(group);
  let memberUsers: User[] | undefined;
  for (const field of form.fields) {
    const title = field.label + (field.required ? " *" : "");
    answers[field.id] = "";
    if (["text", "long_text", "number"].includes(field.kind)) {
      const row = entryRow(
        title,
        "",
        (v) => (answers[field.id] = v),
        field.kind === "long_text",
      );
      rows.append(row);
    } else if (field.kind === "choice" && !field.multiple) {
      answers[field.id] = field.required ? (field.options?.[0] ?? "") : "";
      rows.append(
        selectRow(
          title,
          String(answers[field.id]),
          [
            ...(!field.required
              ? [["", nt("workflows.form_choose")] as const]
              : []),
            ...(field.options ?? []).map((v) => [v, v] as const),
          ],
          (v) => (answers[field.id] = v),
        ),
      );
    } else {
      const picks = el("details", "workflow-form-field");
      picks.open = true;
      picks.append(el("summary", "action-row", title));
      let options: [string, string][];
      if (field.kind === "person") {
        if (field.people?.length)
          options = field.people.map((id) => {
            const user = form.people?.find((u) => u.id === id);
            return [
              id,
              user ? user.display_name + " (@" + user.username + ")" : id,
            ];
          });
        else {
          if (!memberUsers) {
            memberUsers = [];
            let after: string | undefined;
            do {
              const page = await app.api.request<RoomMemberPage>(
                "/api/v1/rooms/" +
                  segment(message.room_id) +
                  "/members" +
                  (after ? "?after=" + segment(after) : ""),
              );
              if (!current() || !node.open) {
                node.close();
                return;
              }
              memberUsers.push(
                ...page.members.map((m) => m.user).filter((u) => !u.bot),
              );
              after = page.next ?? undefined;
            } while (after);
          }
          options = memberUsers.map((u) => [
            u.id,
            u.display_name + " (@" + u.username + ")",
          ]);
        }
      } else options = (field.options ?? []).map((v) => [v, v]);
      const chosen: string[] = [];
      answers[field.id] = chosen;
      const list = el("div");
      const checks: HTMLInputElement[] = [];
      for (const [value, label] of options) {
        const row = switchRow(label, false, (on) => {
          if (!field.multiple) {
            chosen.splice(0);
            for (const check of checks)
              check.checked = check.value === value && on;
          }
          const index = chosen.indexOf(value);
          if (on && index < 0) chosen.push(value);
          else if (!on && index >= 0) chosen.splice(index, 1);
        });
        const check = row.querySelector("input")!;
        check.type = field.multiple ? "checkbox" : "radio";
        check.name = field.id;
        check.value = value;
        checks.push(check);
        row.dataset.search = label.toLowerCase();
        list.append(row);
      }
      if (field.kind === "person") {
        const search = el("input", "pill-entry");
        search.type = "search";
        search.setAttribute("aria-label", t("search"));
        search.addEventListener("input", () => {
          for (const row of list.children)
            (row as HTMLElement).hidden = !(
              row as HTMLElement
            ).dataset.search?.includes(search.value.toLowerCase());
        });
        picks.append(search);
      }
      picks.append(list);
      rows.append(picks);
    }
  }
  const intent = operation();
  body.append(
    button(
      nt("workflows.form_submit"),
      async () => {
        if (!current()) {
          node.close();
          return;
        }
        for (const field of form.fields) {
          const value = answers[field.id];
          if (field.required && (!value || !value.length))
            throw Error(nt("workflows.error_form_required"));
          if (typeof value === "string") {
            const bytes = new TextEncoder().encode(value).length;
            if (bytes > (field.kind === "long_text" ? 4096 : 1024))
              throw Error(nt("workflows.error_form_value"));
            if (
              field.kind === "number" &&
              value &&
              !Number.isFinite(Number(value))
            )
              throw Error(nt("workflows.error_form_value"));
          }
        }
        await app.api.request(
          "/api/v1/forms/" + segment(message.id) + "/answer",
          "POST",
          { operation_id: intent, answers },
        );
        if (current()) node.close();
      },
      "cta",
    ),
  );
  const timer = setInterval(() => {
    const changed = app.model.messages.get(message.id)?.form;
    if (
      !current() ||
      changed?.answered_by ||
      new Date(form.expires_at).getTime() <= Date.now()
    )
      node.close();
  }, 200);
  node.addEventListener("close", () => clearInterval(timer), { once: true });
}
