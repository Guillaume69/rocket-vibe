import type { Step, Trigger, CreateWorkflow } from "./protocol";
export type WorkflowDraft = Omit<CreateWorkflow, "operation_id">;
export const triggerKinds: Trigger["kind"][] = [
  "command",
  "schedule",
  "member_joined",
  "reaction_added",
  "message_posted",
  "webhook",
];
export const stepKinds: Step["kind"][] = ["message", "wait", "http", "form"];
export const hasPerson = (trigger: Trigger) =>
  !["schedule", "webhook"].includes(trigger.kind);
export const hasThread = (trigger: Trigger) =>
  ["reaction_added", "message_posted"].includes(trigger.kind);
export function newTrigger(kind: Trigger["kind"], current: Trigger): Trigger {
  if (kind === current.kind) return current;
  const room = "room" in current ? current.room : "";
  switch (kind) {
    case "command":
      return { kind, name: "" };
    case "schedule":
      return {
        kind,
        every: "day",
        time: "09:00",
        days: [],
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        room,
      };
    case "member_joined":
      return { kind, room };
    case "reaction_added":
      return { kind, room };
    case "message_posted":
      return { kind, room, contains: "" };
    case "webhook":
      return { kind };
  }
}
export function identifier(label: string, taken: string[]): string {
  let base =
    label
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replaceAll("œ", "o")
      .replaceAll("æ", "a")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32)
      .replace(/_+$/, "") || "field";
  if (["trigger", "webhook", "now"].includes(base)) base += "_1";
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = "_" + n;
    const candidate =
      base.slice(0, 32 - suffix.length).replace(/_+$/, "") + suffix;
    if (!taken.includes(candidate)) return candidate;
  }
}
export function newStep(
  kind: Step["kind"],
  trigger: Trigger,
  steps: Step[],
): Step {
  const room = trigger.kind === "webhook" ? "" : "trigger";
  switch (kind) {
    case "message":
      return { kind, room, text: "", in_thread: false };
    case "wait":
      return { kind, seconds: 60 };
    case "http":
      return {
        kind,
        method: "GET",
        url: "https://",
        headers: [],
        continue_on_error: false,
      };
    case "form":
      return {
        kind,
        room,
        recipient: hasPerson(trigger) ? "trigger_user" : "anyone",
        title: "",
        fields: [{ id: "answer", label: "", kind: "text", required: true }],
        save_as: identifier(
          "form",
          steps.flatMap((s) =>
            "save_as" in s && s.save_as ? [s.save_as] : [],
          ),
        ),
      };
  }
}
export function variables(
  trigger: Trigger,
  steps: Step[],
  index: number,
): string[] {
  const person = ["trigger.user.username", "trigger.user.display_name"];
  let names: string[];
  switch (trigger.kind) {
    case "command":
      names = [...person, "trigger.room.name", "trigger.text"];
      break;
    case "schedule":
      names = ["trigger.room.name", "trigger.at"];
      break;
    case "member_joined":
      names = [...person, "trigger.room.name"];
      break;
    case "reaction_added":
      names = [
        ...person,
        "trigger.room.name",
        "trigger.emoji",
        "trigger.message.text",
        "trigger.message.author.username",
      ];
      break;
    case "message_posted":
      names = [...person, "trigger.room.name", "trigger.message.text"];
      break;
    case "webhook":
      names = ["webhook"];
  }
  for (const step of steps.slice(0, index)) {
    if (!("save_as" in step) || !step.save_as) continue;
    const name = step.save_as;
    if (step.kind === "message") names.push(name + ".message_id");
    else if (step.kind === "http") names.push(name + ".status", name + ".body");
    else if (step.kind === "form") {
      names.push(name + ".by.username", name + ".by.display_name");
      for (const field of step.fields) {
        names.push(name + ".answers." + field.id);
        if (field.kind === "person")
          names.push(
            name + ".mentions." + field.id,
            name +
              ".people." +
              field.id +
              (field.multiple ? ".0" : "") +
              ".display_name",
          );
      }
    }
  }
  return [...names, "now"];
}
export function normalized(draft: WorkflowDraft): WorkflowDraft {
  const d = structuredClone(draft);
  d.name = d.name.trim();
  d.description = d.description?.trim() ?? "";
  if (d.trigger.kind === "command")
    d.trigger.name = d.trigger.name.trim().replace(/^\/+/, "").toLowerCase();
  if (d.trigger.kind === "reaction_added")
    d.trigger.emoji =
      d.trigger.emoji?.trim().replace(/^:+|:+$/g, "") || undefined;
  if (d.trigger.kind === "message_posted")
    d.trigger.contains = d.trigger.contains.trim();
  for (const step of d.steps) {
    if ("save_as" in step) step.save_as = step.save_as?.trim() || undefined;
    if (step.kind === "message")
      step.in_thread = hasThread(d.trigger) && !!step.in_thread;
    if (step.kind === "http") {
      step.url = step.url.trim();
      step.headers = step.headers
        ?.filter((h) => h.name.trim())
        .map((h) => ({ ...h, name: h.name.trim() }));
      step.body = step.body || undefined;
    }
    if (step.kind === "form") {
      step.title = step.title.trim();
      step.save_as = step.save_as?.trim() ?? "";
      for (const field of step.fields) {
        field.label = field.label.trim();
        if (field.kind !== "choice") field.options = [];
        if (field.kind !== "person") field.people = [];
        field.multiple =
          ["choice", "person"].includes(field.kind) && !!field.multiple;
      }
    }
  }
  return d;
}
