import type { Message, Node as MarkdownNode } from "./protocol";
import { language } from "./i18n.ts";
export function systemText(message: Message): string {
  const value = message.system;
  if (!value) return message.text;
  const actor = message.author.display_name || message.author.username;
  const labels: Record<string, [string, string]> = {
    room_created: ["created the room", "a créé le salon"],
    room_renamed: ["renamed the room", "a renommé le salon"],
    topic_changed: ["changed the topic", "a modifié le sujet"],
    description_changed: [
      "changed the description",
      "a modifié la description",
    ],
    announcement_changed: ["changed the announcement", "a modifié l’annonce"],
    privacy_changed: [
      "changed the room privacy",
      "a modifié la confidentialité du salon",
    ],
    read_only_changed: [
      "changed read-only mode",
      "a modifié le mode lecture seule",
    ],
    member_joined: ["joined the room", "a rejoint le salon"],
    member_left: ["left the room", "a quitté le salon"],
    member_added: ["added", "a ajouté"],
    member_removed: ["removed", "a retiré"],
    role_changed: ["changed the role of", "a modifié le rôle de"],
    call_started: ["started a call", "a lancé un appel"],
  };
  let detail = "";
  if ("user" in value)
    detail = " " + (value.user.display_name || value.user.username);
  if ("name" in value) detail = " " + value.name;
  if ("topic" in value) detail = ": " + value.topic;
  if ("role" in value) detail += " (" + value.role + ")";
  return (
    actor +
    " " +
    (labels[value.kind]?.[language === "fr" ? 1 : 0] || value.kind) +
    detail
  );
}
function plain(nodes: MarkdownNode[]): string {
  return nodes
    .map((node) =>
      "children" in node
        ? plain(node.children)
        : "text" in node
          ? node.text
          : "name" in node
            ? node.name
            : node.kind === "emoji"
              ? ":" + node.shortcode + ":"
              : node.kind === "break"
                ? " "
                : "",
    )
    .join("");
}
export const previewText = (message: Message): string =>
  message.system
    ? systemText(message)
    : message.body
      ? plain(message.body.nodes)
      : message.text;
export function decorate(text: string): string | undefined {
  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return text.trim().startsWith("/") ? undefined : text;
  const command = match[1],
    params = (match[2] || "").trim();
  const faces: Record<string, string> = {
    gimme: "༼ つ ◕_◕ ༽つ",
    lennyface: "( ͡° ͜ʖ ͡°)",
    shrug: "¯\\_(ツ)_/¯",
    tableflip: "(╯°□°）╯︵ ┻━┻",
    unflip: "┬─┬ ノ( ゜-゜ノ)",
  };
  if (command === "me") return params ? "_" + params + "_" : "";
  if (command === "gimme")
    return [faces[command], params].filter(Boolean).join(" ");
  if (faces[command]) return [params, faces[command]].filter(Boolean).join(" ");
  return undefined;
}
