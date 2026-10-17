import type { Node } from "./protocol";

/** Read plain metadata with GTK's markdown markers into the existing safe renderer. */
export function inlineText(text: string, depth = 0): Node[] {
  if (depth > 16) return [{ kind: "text", text }];
  const out: Node[] = [];
  const append = (value: string) => {
    const last = out.at(-1);
    if (last?.kind === "text") last.text += value;
    else out.push({ kind: "text", text: value });
  };
  for (let at = 0; at < text.length;) {
    const rest = text.slice(at);
    const escaped = /^\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/.exec(rest);
    if (escaped) {
      append(escaped[1]);
      at += escaped[0].length;
      continue;
    }
    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      out.push({ kind: "inline_code", text: code[1] });
      at += code[0].length;
      continue;
    }
    const link = /^\[([^\]\n]*)\]\(([^\s)]+)\)/.exec(rest);
    if (link) {
      out.push({
        kind: "link",
        href: link[2],
        children: inlineText(link[1], depth + 1),
      });
      at += link[0].length;
      continue;
    }
    const url = /^https?:\/\/[^\s<>]+/.exec(rest);
    if (url) {
      const href = url[0].replace(/[.,;:!?)'"]+$/, "");
      out.push({
        kind: "link",
        href,
        children: [{ kind: "text", text: href }],
      });
      at += href.length;
      continue;
    }
    const emphasis = /^(\*\*|__|~~|\*|_|~)(\S(?:[^\n]*?\S)?)\1(?!\1)/.exec(
      rest,
    );
    if (
      emphasis &&
      !(emphasis[1][0] === "_" && /[\p{L}\p{N}]/u.test(text[at - 1] || ""))
    ) {
      const kind =
        emphasis[1][0] === "*"
          ? "bold"
          : emphasis[1][0] === "_"
            ? "italic"
            : "strike";
      out.push({ kind, children: inlineText(emphasis[2], depth + 1) });
      at += emphasis[0].length;
      continue;
    }
    const emoji = /^:([a-zA-Z0-9_+\-]+):/.exec(rest);
    if (emoji) {
      out.push({ kind: "emoji", shortcode: emoji[1] });
      at += emoji[0].length;
      continue;
    }
    const mention = /^([@#])([\p{L}\p{N}_\-.]+)/u.exec(rest);
    if (mention && !/[\p{L}\p{N}_]/u.test(text[at - 1] || "")) {
      out.push({
        kind: mention[1] === "@" ? "mention" : "room_mention",
        name: mention[2],
      });
      at += mention[0].length;
      continue;
    }
    append(text[at++]);
  }
  return out;
}

/** A title drawn inside its own link: inline markdown on one line, its links reduced to their text. */
export function linkedTitle(text: string): Node[] {
  const flatten = (nodes: Node[]): Node[] =>
    nodes.flatMap((node): Node[] =>
      node.kind === "link"
        ? flatten(node.children)
        : "children" in node
          ? [{ ...node, children: flatten(node.children) }]
          : [node],
    );
  return flatten(inlineText(text.replace(/\s*\n\s*/g, " ")));
}

export function metadataMarkdown(text: string, depth = 0): Node[] {
  if (depth > 16)
    return [{ kind: "paragraph", children: [{ kind: "text", text }] }];
  const lines = text.replace(/\r\n?/g, "\n").split("\n"),
    out: Node[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      const content: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```/.test(lines[index]))
        content.push(lines[index++]);
      if (index < lines.length) index++;
      out.push({
        kind: "code_block",
        language: fence[1],
        text: content.join("\n"),
      });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      out.push({
        kind: "heading",
        level: heading[1].length,
        children: inlineText(heading[2]),
      });
      index++;
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      out.push({ kind: "rule" });
      index++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const content: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]))
        content.push(lines[index++].replace(/^>\s?/, ""));
      out.push({
        kind: "quote",
        children: metadataMarkdown(content.join("\n"), depth + 1),
      });
      continue;
    }
    const list = /^\s*(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(line);
    if (list) {
      const ordered = !!list[2],
        children: Node[] = [];
      while (index < lines.length) {
        const item = /^\s*(?:([-*+])|(\d+)\.)\s+(.*)$/.exec(lines[index]);
        if (!item || !!item[2] !== ordered) break;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
        children.push({
          kind: "list_item",
          children: inlineText(task ? task[2] : item[3]),
          ...(task ? { checked: task[1].toLowerCase() === "x" } : {}),
        });
        index++;
      }
      out.push({
        kind: "list",
        children,
        ...(ordered ? { start: Number(list[2]) } : {}),
      });
      continue;
    }
    const children: Node[] = inlineText(line);
    index++;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(?:#{1,4}\s|>\s?|\s*```|\s*(?:[-*+] |\d+\. ))/.test(lines[index])
    ) {
      children.push({ kind: "break" }, ...inlineText(lines[index++]));
    }
    out.push({ kind: "paragraph", children });
  }
  return out;
}
