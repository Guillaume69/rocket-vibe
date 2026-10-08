import type { App } from "./app";
import type {
  Workflow,
  WorkflowList,
  WorkflowRunList,
  WebhookSecret,
  BotList,
  AccountPermissions,
  Step,
  FormField,
  User,
} from "./protocol";
import { operation, segment } from "./api";
import { button, el, toast } from "./dom";
import { t } from "./i18n";
import { nt } from "./native-i18n";
import { actionRow, preferencesGroup, type SidebarHost } from "./sidebar";
import {
  accountFence,
  entryRow,
  selectRow,
  switchRow,
  confirmAction,
  onceSecret,
} from "./preferences-controls";
import { recentProof } from "./security";
import { iconButton } from "./icons";
import {
  type WorkflowDraft,
  newTrigger,
  newStep,
  normalized,
  variables,
  identifier,
  triggerKinds,
  stepKinds,
  hasPerson,
  hasThread,
} from "./workflows-model";
export async function workflowsPage(
  app: App,
  host: SidebarHost,
  page: HTMLElement,
  all = false,
): Promise<void> {
  const valid = accountFence(app);
  const [list, bots, permissions] = await Promise.all([
    app.api.request<WorkflowList>(
      "/api/v1/workflows" + (all ? "?all=true" : ""),
    ),
    app.api.request<BotList>("/api/v1/bots"),
    app.api.request<AccountPermissions>("/api/v1/me/permissions"),
  ]);
  if (!valid() || !page.isConnected) return;
  page.classList.add("native-workflows");
  const [group, rows] = preferencesGroup(
    nt(all ? "settings.cat.workflows" : "workflows.title"),
  );
  group.append(el("p", "dim", nt("workflows.intro")));
  group.querySelector("h3")?.append(
    iconButton("refresh", nt("security.refresh"), () => {
      page.replaceChildren();
      return workflowsPage(app, host, page, all);
    }),
  );
  if (!list.workflows.length) rows.append(actionRow(nt("workflows.empty")));
  for (const workflow of list.workflows) {
    const row = actionRow(
      workflow.name,
      triggerSummary(workflow, app) +
        "\n" +
        (workflow.last_run
          ? nt("workflows.run." + workflow.last_run.state)
          : nt("workflows.never_run")),
      () => open(workflow),
    );
    const badge = el(
      "span",
      "admin-badge " + (workflow.enabled ? "workflow-on" : "deactivated"),
      nt(workflow.enabled ? "workflows.on" : "workflows.off"),
    );
    row.insertBefore(badge, row.lastElementChild);
    rows.append(row);
  }
  const active = bots.bots.filter((b) => !b.disabled);
  if (!all) {
    if (!permissions.create_bot) rows.append(actionRow(nt("workflows.closed")));
    else if (!active.length) rows.append(actionRow(nt("workflows.no_bot")));
    else rows.append(actionRow(nt("workflows.create"), "", () => open()));
  }
  page.append(group);
  function open(workflow?: Workflow) {
    host.push(workflow?.name ?? nt("workflows.new"), (p) =>
      editor(
        app,
        host,
        p,
        active.map((b) => b.user),
        workflow,
      ),
    );
  }
}
function triggerSummary(workflow: Workflow, app: App): string {
  const tr = workflow.trigger;
  const room = (id: string) => app.model.rooms.get(id)?.name ?? id;
  switch (tr.kind) {
    case "command":
      return nt("workflows.summary.command", { name: tr.name });
    case "webhook":
      return nt("workflows.summary.webhook");
    case "member_joined":
      return nt("workflows.summary.member_joined", { room: room(tr.room) });
    case "reaction_added":
      return nt(
        tr.emoji
          ? "workflows.summary.reaction"
          : "workflows.summary.any_reaction",
        { emoji: tr.emoji ?? "", room: room(tr.room) },
      );
    case "message_posted":
      return nt("workflows.summary.message_posted", {
        text: tr.contains,
        room: room(tr.room),
      });
    case "schedule": {
      const when =
        tr.every === "hour"
          ? nt("workflows.summary.hour", { minute: tr.time.split(":")[1] })
          : tr.every === "day"
            ? nt("workflows.summary.day", { time: tr.time })
            : nt("workflows.summary.week", {
                days: [...new Set(tr.days)]
                  .sort()
                  .map((day) => nt("workflows.day." + day))
                  .join(", "),
                time: tr.time,
              });
      return nt("workflows.summary.schedule", {
        when,
        zone: tr.timezone,
        room: room(tr.room),
      });
    }
  }
}
async function editor(
  app: App,
  host: SidebarHost,
  page: HTMLElement,
  bots: User[],
  workflow?: Workflow,
): Promise<void> {
  const valid = accountFence(app),
    owner = !workflow || workflow.owner.id === app.account?.session.user.id;
  const draft: WorkflowDraft = workflow
    ? {
        name: workflow.name,
        description: workflow.description,
        bot_id: workflow.bot.id,
        enabled: workflow.enabled,
        trigger: structuredClone(workflow.trigger),
        steps: structuredClone(workflow.steps),
      }
    : {
        name: "",
        description: "",
        bot_id: bots[0]?.id ?? "",
        enabled: true,
        trigger: { kind: "command", name: "" },
        steps: [],
      };
  let revision = workflow?.revision ?? "",
    saved = workflow ? structuredClone(draft) : undefined;
  const path = workflow
    ? "/api/v1/workflows/" + segment(workflow.id)
    : "/api/v1/workflows";
  let people: User[] = [];
  const freshFields = new WeakSet<FormField>();
  let runGroup: HTMLElement | undefined;
  let enabled: HTMLElement | undefined;
  page.classList.add("native-workflow");
  if (!owner) {
    const [group, rows] = preferencesGroup();
    rows.append(
      actionRow(workflow!.name, workflow!.description),
      actionRow("@" + workflow!.owner.username, "@" + workflow!.bot.username),
      actionRow(triggerSummary(workflow!, app)),
    );
    page.append(group);
    await runs();
    danger();
    return;
  }
  const [general, fields] = preferencesGroup();
  fields.append(
    entryRow(nt("workflows.name"), draft.name, (v) => (draft.name = v)),
    entryRow(
      nt("workflows.description"),
      draft.description ?? "",
      (v) => (draft.description = v),
    ),
  );
  if (workflow && !bots.some((b) => b.id === workflow!.bot.id))
    bots = [...bots, workflow.bot];
  fields.append(
    selectRow(
      nt("workflows.bot"),
      draft.bot_id,
      bots.map((b) => [b.id, b.display_name + " (@" + b.username + ")"]),
      (v) => (draft.bot_id = v),
    ),
  );
  enabled = switchRow(
    nt("workflows.enabled"),
    !!draft.enabled,
    (v) => (draft.enabled = v),
  );
  fields.append(enabled);
  page.append(general);
  const [trigger, triggerRows] = preferencesGroup(nt("workflows.trigger"));
  const triggerFields = el("div");
  triggerRows.append(
    selectRow(
      nt("workflows.trigger_kind"),
      draft.trigger.kind,
      triggerKinds.map((k) => [k, nt("workflows.trigger_kind." + k)]),
      (v) => {
        draft.trigger = newTrigger(
          v as WorkflowDraft["trigger"]["kind"],
          draft.trigger,
        );
        drawTrigger();
        drawSteps();
      },
    ),
    triggerFields,
  );
  page.append(trigger);
  const steps = el("div", "workflow-steps");
  page.append(steps);
  const [add, addRows] = preferencesGroup();
  let kind: Step["kind"] = "message";
  addRows.append(
    selectRow(
      nt("workflows.add_step"),
      kind,
      stepKinds.map((k) => [k, nt("workflows.step." + k)]),
      (v) => (kind = v as Step["kind"]),
    ),
    actionRow(nt("workflows.add_step"), "", () => {
      if (draft.steps.length >= 20) return;
      draft.steps.push(newStep(kind, draft.trigger, draft.steps));
      drawSteps();
    }),
  );
  page.append(add);
  const [actions, actionRows] = preferencesGroup();
  const note = el("p", "dim");
  page.append(actions, note);
  actionRows.append(
    actionRow(t("save"), "", async () => {
      if (!valid()) return;
      const current = normalized(draft);
      if (!current.name || !current.steps.length)
        throw Error(nt("workflows.error_invalid"));
      const value = await app.api.request<Workflow>(
        path,
        workflow ? "PUT" : "POST",
        {
          ...current,
          operation_id: operation(),
          ...(workflow ? { revision } : {}),
        },
      );
      if (!valid()) return;
      if (!workflow) {
        host.pop();
        host.push(value.name, (p) => editor(app, host, p, bots, value));
        return;
      }
      revision = value.revision;
      saved = structuredClone(current);
      workflow = value;
      note.textContent = nt("workflows.saved");
      drawTrigger();
    }),
  );
  const test = workflow
    ? actionRow(nt("workflows.test"), "", async () => {
        if (
          !valid() ||
          JSON.stringify(normalized(draft)) !==
            JSON.stringify(normalized(saved!))
        )
          return;
        await app.api.request(path + "/test", "POST", {
          operation_id: operation(),
        });
        if (valid()) await runs();
      })
    : undefined;
  const commandNote = actionRow(nt("workflows.error_test_command"));
  if (workflow) {
    actionRows.append(commandNote, test!);
    const timer = setInterval(() => {
      if (!page.isConnected) {
        clearInterval(timer);
        return;
      }
      const command = saved?.trigger.kind === "command";
      test!.hidden = !!command;
      commandNote.hidden = !command;
      (test as HTMLButtonElement).disabled =
        JSON.stringify(normalized(draft)) !==
        JSON.stringify(normalized(saved!));
    }, 200);
    await runs();
    danger();
  }
  drawTrigger();
  drawSteps();
  people = await app.api.request<User[]>("/api/v1/users").catch(() => []);
  if (
    valid() &&
    page.isConnected &&
    draft.steps.some(
      (s) => s.kind === "form" && s.fields.some((f) => f.kind === "person"),
    )
  )
    drawSteps();
  function roomRow(
    current: string,
    allowTrigger: boolean,
    changed: (id: string) => void,
  ): HTMLElement {
    const choices: [string, string][] = [["", nt("workflows.room_none")]];
    if (allowTrigger) choices.push(["trigger", nt("workflows.room_trigger")]);
    for (const room of app.model.rooms.values())
      if (!room.encrypted) choices.push([room.id, room.name]);
    if (current && !choices.some(([id]) => id === current))
      choices.push([current, current]);
    return selectRow(nt("workflows.room"), current, choices, changed);
  }
  function drawTrigger() {
    triggerFields.replaceChildren();
    const tr = draft.trigger;
    switch (tr.kind) {
      case "command":
        triggerFields.append(
          entryRow(nt("workflows.command_name"), tr.name, (v) => (tr.name = v)),
          el("p", "dim", nt("workflows.command_hint")),
        );
        break;
      case "schedule": {
        const settings = el("div");
        const redraw = () => {
          settings.replaceChildren();
          const [hour, minute] = tr.time.split(":");
          if (tr.every !== "hour")
            settings.append(
              entryRow(
                nt("workflows.time"),
                hour,
                (v) =>
                  (tr.time =
                    String(Number(v)).padStart(2, "0") +
                    ":" +
                    tr.time.split(":")[1]),
              ),
            );
          settings.append(
            entryRow(
              nt("workflows.minute"),
              minute,
              (v) =>
                (tr.time =
                  tr.time.split(":")[0] +
                  ":" +
                  String(Number(v)).padStart(2, "0")),
            ),
          );
          if (tr.every === "week") {
            const days = el("div", "weekday-buttons");
            for (let day = 1; day <= 7; day++) {
              const row = switchRow(
                nt("workflows.day." + day),
                tr.days?.includes(day) ?? false,
                (on) => {
                  tr.days = (tr.days ?? []).filter((d) => d !== day);
                  if (on) tr.days.push(day);
                  tr.days.sort();
                },
              );
              days.append(row);
            }
            settings.append(days);
          }
        };
        triggerFields.append(
          selectRow(
            nt("workflows.every"),
            tr.every,
            ["hour", "day", "week"].map((v) => [v, nt("workflows.every." + v)]),
            (v) => {
              tr.every = v as typeof tr.every;
              redraw();
            },
          ),
          settings,
          entryRow(
            nt("workflows.timezone"),
            tr.timezone,
            (v) => (tr.timezone = v),
          ),
          roomRow(tr.room, false, (v) => (tr.room = v)),
        );
        redraw();
        break;
      }
      case "member_joined":
        triggerFields.append(roomRow(tr.room, false, (v) => (tr.room = v)));
        break;
      case "reaction_added":
        triggerFields.append(
          roomRow(tr.room, false, (v) => (tr.room = v)),
          entryRow(
            nt("workflows.emoji"),
            tr.emoji ?? "",
            (v) => (tr.emoji = v),
          ),
          el("p", "dim", nt("workflows.emoji_hint")),
        );
        break;
      case "message_posted":
        triggerFields.append(
          roomRow(tr.room, false, (v) => (tr.room = v)),
          entryRow(
            nt("workflows.contains"),
            tr.contains,
            (v) => (tr.contains = v),
          ),
          el("p", "dim", nt("workflows.contains_hint")),
        );
        break;
      case "webhook":
        if (!workflow || saved?.trigger.kind !== "webhook") {
          triggerFields.append(actionRow(nt("workflows.webhook_save_first")));
          break;
        }
        triggerFields.append(
          actionRow(
            nt(
              workflow.has_webhook
                ? "workflows.webhook_regenerate"
                : "workflows.webhook_generate",
            ),
            "",
            () => {
              const make = async () => {
                await recentProof(app);
                if (!valid()) return;
                const secret = await app.api.request<WebhookSecret>(
                  path + "/webhook",
                  "POST",
                  { operation_id: operation() },
                );
                if (!valid()) return;
                workflow!.has_webhook = true;
                onceSecret(
                  app,
                  valid,
                  nt("workflows.webhook_title"),
                  nt("workflows.webhook_once"),
                  [["", new URL(secret.path, location.origin).href]],
                );
                if (page.isConnected) drawTrigger();
              };
              if (workflow!.has_webhook)
                confirmAction(
                  nt("workflows.webhook_replace"),
                  nt("workflows.webhook_replace_body"),
                  make,
                );
              else return make();
            },
          ),
        );
        break;
    }
  }
  function drawSteps() {
    steps.replaceChildren();
    draft.steps.forEach((step, index) => {
      const [group, rows] = preferencesGroup(
        index + 1 + ". " + nt("workflows.step." + step.kind),
      );
      group.classList.add("workflow-step");
      const controls = el("div", "workflow-step-controls");
      const up = iconButton("up", nt("workflows.move_up"), () => {
        [draft.steps[index - 1], draft.steps[index]] = [
          draft.steps[index],
          draft.steps[index - 1],
        ];
        drawSteps();
      });
      up.disabled = index === 0;
      const down = iconButton("down", nt("workflows.move_down"), () => {
        [draft.steps[index], draft.steps[index + 1]] = [
          draft.steps[index + 1],
          draft.steps[index],
        ];
        drawSteps();
      });
      down.disabled = index === draft.steps.length - 1;
      controls.append(
        up,
        down,
        iconButton("trash", nt("workflows.step_remove"), () =>
          confirmAction(
            nt("workflows.step_remove_confirm", { n: index + 1 }),
            nt("workflows.step_remove_body"),
            async () => {
              const at = draft.steps.indexOf(step);
              if (at >= 0) draft.steps.splice(at, 1);
              drawSteps();
            },
          ),
        ),
      );
      group.querySelector("h3")?.append(controls);
      steps.append(group);
      let target: HTMLInputElement | HTMLTextAreaElement | undefined;
      const template = (
        title: string,
        value: string,
        change: (v: string) => void,
        area = false,
      ) => {
        const row = entryRow(title, value, change, area);
        const input = row.querySelector("input,textarea") as
          HTMLInputElement | HTMLTextAreaElement;
        target ??= input;
        input.addEventListener("focus", () => (target = input));
        return row;
      };
      if (step.kind === "message" || step.kind === "http") {
        const menu = el("details", "variables-menu");
        const title = el("summary", "", nt("workflows.variables"));
        menu.append(title);
        menu.addEventListener("toggle", () => {
          if (!menu.open) return;
          menu.querySelector(".variables-list")?.remove();
          const list = el("div", "variables-list");
          for (const variable of variables(draft.trigger, draft.steps, index))
            list.append(
              button("{{" + variable + "}}", () => {
                if (target) {
                  target.setRangeText(
                    "{{" + variable + "}}",
                    target.selectionStart ?? target.value.length,
                    target.selectionEnd ?? target.value.length,
                    "end",
                  );
                  target.dispatchEvent(new Event("input"));
                  target.focus();
                }
                menu.open = false;
              }),
            );
          menu.append(list);
        });
        controls.prepend(menu);
      }
      switch (step.kind) {
        case "message":
          rows.append(
            roomRow(
              step.room,
              draft.trigger.kind !== "webhook",
              (v) => (step.room = v),
            ),
            template(
              nt("workflows.text"),
              step.text,
              (v) => (step.text = v),
              true,
            ),
          );
          if (hasThread(draft.trigger))
            rows.append(
              switchRow(
                nt("workflows.in_thread"),
                !!step.in_thread,
                (v) => (step.in_thread = v),
              ),
            );
          break;
        case "wait": {
          const units: [string, string][] = [
            "seconds",
            "minutes",
            "hours",
            "days",
          ].map((v) => [v, nt("workflows.unit." + v)]);
          const scales = [1, 60, 3600, 86400];
          let unit = 3;
          while (
            unit > 0 &&
            (step.seconds === 0 || step.seconds % scales[unit])
          )
            unit--;
          let amount = step.seconds / scales[unit];
          rows.append(
            entryRow(nt("workflows.wait_for"), String(amount), (v) => {
              amount = Number(v);
              step.seconds = amount * scales[unit];
            }),
            selectRow(nt("workflows.unit"), units[unit][0], units, (v) => {
              unit = units.findIndex(([id]) => id === v);
              step.seconds = amount * scales[unit];
            }),
          );
          break;
        }
        case "http": {
          rows.append(
            selectRow(
              nt("workflows.method"),
              step.method,
              ["GET", "POST", "PUT", "PATCH", "DELETE"].map((v) => [v, v]),
              (v) => (step.method = v as typeof step.method),
            ),
            template(nt("workflows.url"), step.url, (v) => (step.url = v)),
          );
          const headers = el("details", "workflow-headers");
          headers.append(el("summary", "action-row", nt("workflows.headers")));
          const entries = el("div");
          headers.append(entries);
          const draw = () => {
            entries.replaceChildren();
            for (const header of step.headers ?? []) {
              const line = el("div", "workflow-header-row");
              line.append(
                entryRow(
                  nt("workflows.header_name"),
                  header.name,
                  (v) => (header.name = v),
                ),
                template(
                  nt("workflows.header_value"),
                  header.value,
                  (v) => (header.value = v),
                ),
                iconButton("trash", nt("workflows.header_remove"), () => {
                  step.headers = step.headers?.filter((h) => h !== header);
                  draw();
                }),
              );
              entries.append(line);
            }
            if ((step.headers?.length ?? 0) < 10)
              entries.append(
                actionRow(nt("workflows.header_add"), "", () => {
                  (step.headers ??= []).push({ name: "", value: "" });
                  draw();
                }),
              );
          };
          draw();
          rows.append(
            headers,
            template(
              nt("workflows.body"),
              step.body ?? "",
              (v) => (step.body = v),
              true,
            ),
            switchRow(
              nt("workflows.continue_on_error"),
              !!step.continue_on_error,
              (v) => (step.continue_on_error = v),
            ),
          );
          break;
        }
        case "form": {
          rows.append(
            roomRow(
              step.room,
              draft.trigger.kind !== "webhook",
              (v) => (step.room = v),
            ),
            selectRow(
              nt("workflows.recipient"),
              step.recipient,
              [
                ...(hasPerson(draft.trigger)
                  ? [
                      [
                        "trigger_user",
                        nt("workflows.recipient.trigger_user"),
                      ] as const,
                    ]
                  : []),
                ["anyone", nt("workflows.recipient.anyone")],
              ],
              (v) => (step.recipient = v as typeof step.recipient),
            ),
            entryRow(
              nt("workflows.form_title"),
              step.title,
              (v) => (step.title = v),
            ),
          );
          for (const f of step.fields) rows.append(formField(step, f));
          if (step.fields.length < 10)
            rows.append(
              actionRow(nt("workflows.field_add"), "", () => {
                step.fields.push({
                  id: identifier(
                    "answer",
                    step.fields.map((f) => f.id),
                  ),
                  label: "",
                  kind: "text",
                  required: true,
                });
                drawSteps();
              }),
            );
          break;
        }
      }
      if ("save_as" in step)
        rows.append(
          entryRow(
            nt("workflows.save_as"),
            step.save_as ?? "",
            (v) => (step.save_as = v),
          ),
        );
    });
  }
  function formField(
    step: Extract<Step, { kind: "form" }>,
    f: FormField,
  ): HTMLElement {
    const details = el("details", "workflow-field");
    details.open = true;
    const summary = el(
      "summary",
      "action-row",
      f.label || nt("workflows.field_label"),
    );
    const idLabel = el(
      "span",
      "action-row-subtitle",
      nt("workflows.field_id", { id: f.id }),
    );
    summary.append(idLabel);
    details.append(summary);
    if (!f.label) freshFields.add(f);
    details.append(
      entryRow(nt("workflows.field_label"), f.label, (v) => {
        f.label = v;
        if (freshFields.has(f)) {
          f.id = identifier(
            v,
            step.fields.filter((field) => field !== f).map((field) => field.id),
          );
          idLabel.textContent = nt("workflows.field_id", { id: f.id });
        }
      }),
      selectRow(
        nt("workflows.field_kind"),
        f.kind,
        ["text", "long_text", "number", "choice", "person"].map((v) => [
          v,
          nt("workflows.field." + v),
        ]),
        (v) => {
          f.kind = v as FormField["kind"];
          drawSteps();
        },
      ),
      switchRow(
        nt("workflows.field_required"),
        !!f.required,
        (v) => (f.required = v),
      ),
    );
    if (f.kind === "choice")
      details.append(
        entryRow(
          nt("workflows.field_options"),
          f.options?.join(", ") ?? "",
          (v) =>
            (f.options = v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)),
        ),
      );
    if (f.kind === "person") {
      const choices = el("div", "workflow-people");
      let mode = f.people?.length ? "these" : "any";
      const selected = el("div");
      const menu = el("details", "variables-menu");
      menu.append(el("summary", "", nt("workflows.people_add")));
      const search = el("input", "pill-entry");
      search.type = "search";
      search.setAttribute("aria-label", nt("workflows.people_search"));
      const offered = el("div", "variables-list");
      menu.append(offered);
      const draw = () => {
        selected.replaceChildren();
        for (const id of f.people ?? []) {
          const user = people.find((p) => p.id === id);
          const row = actionRow(
            user?.display_name ?? id,
            user ? "@" + user.username : "",
          );
          row.append(
            iconButton("trash", nt("workflows.people_remove"), () => {
              f.people = f.people?.filter((p) => p !== id);
              draw();
            }),
          );
          selected.append(row);
        }
        offered.replaceChildren(search);
        for (const user of people.filter(
          (u) =>
            !u.bot &&
            !(f.people ?? []).includes(u.id) &&
            (u.display_name + " " + u.username)
              .toLowerCase()
              .includes(search.value.toLowerCase()),
        ))
          offered.append(
            button(user.display_name + " (@" + user.username + ")", () => {
              if ((f.people?.length ?? 0) >= 50)
                throw Error(nt("workflows.people_limit"));
              (f.people ??= []).push(user.id);
              mode = "these";
              menu.open = false;
              draw();
            }),
          );
        selected.hidden = mode === "any";
        menu.hidden = mode === "any";
      };
      const modeRow = selectRow(
        nt("workflows.field.person"),
        mode,
        [
          ["any", nt("workflows.people_any")],
          ["these", nt("workflows.people_these")],
        ],
        (v) => {
          mode = v;
          if (v === "any") f.people = [];
          else if (!f.people?.length) menu.open = true;
          draw();
        },
      );
      search.addEventListener("input", draw);
      draw();
      choices.append(modeRow, selected, menu);
      details.append(choices);
    }
    if (["choice", "person"].includes(f.kind))
      details.append(
        switchRow(
          nt("workflows.field_multiple"),
          !!f.multiple,
          (v) => (f.multiple = v),
        ),
      );
    details.append(
      actionRow(nt("workflows.field_remove"), "", () => {
        step.fields = step.fields.filter((field) => field !== f);
        drawSteps();
      }),
    );
    return details;
  }
  async function runs() {
    if (!workflow || !valid()) return;
    const list = await app.api.request<WorkflowRunList>(path + "/runs");
    if (!valid() || !page.isConnected) return;
    runGroup?.remove();
    const [group, rows] = preferencesGroup(nt("workflows.runs"));
    runGroup = group;
    group
      .querySelector("h3")
      ?.append(iconButton("refresh", nt("security.refresh"), runs));
    if (!list.runs.length) rows.append(actionRow(nt("workflows.never_run")));
    for (const run of list.runs)
      rows.append(
        actionRow(
          nt("workflows.run." + run.state) +
            " · " +
            nt("workflows.run_step", { n: run.step + 1 }),
          new Date(run.created_at).toLocaleString() +
            (run.error ? "\n" + run.error : ""),
        ),
      );
    page.append(group);
  }
  function danger() {
    if (!workflow) return;
    const [group, rows] = preferencesGroup();
    const off = actionRow(nt("workflows.disable"), "", async () => {
      if (!valid()) return;
      const value = await app.api.request<Workflow>(path + "/disable", "POST", {
        operation_id: operation(),
      });
      if (!valid()) return;
      revision = value.revision;
      draft.enabled = false;
      if (saved) saved.enabled = false;
      enabled?.querySelector("input")?.removeAttribute("checked");
      const toggle = page.querySelector<HTMLInputElement>(
        'input[aria-label="' + nt("workflows.enabled") + '"]',
      );
      if (toggle) toggle.checked = false;
      toast(nt("workflows.disabled"));
      await runs();
    });
    rows.append(off);
    const remove = actionRow(nt("workflows.delete"), "", () =>
      confirmAction(
        nt("workflows.delete_confirm", { name: workflow!.name }),
        nt("workflows.delete_body"),
        async () => {
          if (!valid()) return;
          await app.api.request(path, "DELETE");
          if (valid()) host.select("workflows");
        },
      ),
    );
    remove.classList.add("destructive");
    rows.append(remove);
    page.append(group);
  }
}
