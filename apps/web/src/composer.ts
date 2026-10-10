import { el } from "./dom";
type Style =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "codeblock"
  | "heading"
  | "quote"
  | "marker";
interface Span {
  start: number;
  end: number;
  style: Style;
}
export interface Composer extends HTMLDivElement {
  dispose(): void;
  value: string;
  selectionStart: number;
  selectionEnd: number;
  disabled: boolean;
  placeholder: string;
  setSelectionRange(start: number, end: number): void;
  setRangeText(
    text: string,
    start: number,
    end: number,
    mode?: "select" | "end" | "start" | "preserve",
  ): void;
}
export function draftSpans(text: string): Span[] {
  const out: Span[] = [];
  const inline = (from: number, to: number, depth = 0) => {
    if (depth > 32) return;
    for (let i = from; i < to; i++) {
      const marker = text[i],
        width = marker === "*" && text[i + 1] === "*" ? 2 : 1;
      if (
        !"* _ ~ \x60".split(" ").includes(marker) ||
        i + width >= to ||
        /\s/.test(text[i + width])
      )
        continue;
      const token = marker.repeat(width);
      let end = i + width + 1;
      while (
        end + width <= to &&
        (text.slice(end, end + width) !== token || /\s/.test(text[end - 1]))
      )
        end++;
      if (end + width > to) continue;
      out.push(
        { start: i, end: i + width, style: "marker" },
        {
          start: i + width,
          end,
          style:
            marker === "*"
              ? "bold"
              : marker === "_"
                ? "italic"
                : marker === "~"
                  ? "strike"
                  : "code",
        },
        { start: end, end: end + width, style: "marker" },
      );
      if (marker !== "\x60") inline(i + width, end, depth + 1);
      i = end + width - 1;
    }
  };
  let start = 0,
    fenced = false;
  for (const line of text.split("\n")) {
    const end = start + line.length;
    if (line.trimStart().startsWith("\x60\x60\x60")) {
      out.push({ start, end, style: "marker" });
      fenced = !fenced;
    } else if (fenced) out.push({ start, end, style: "codeblock" });
    else {
      const prefix = /^(# |> |[-*] |\d+\. )/.exec(line)?.[0];
      let body = start;
      if (prefix) {
        body += prefix.length;
        out.push({ start, end: body, style: "marker" });
        if (prefix === "# ") out.push({ start: body, end, style: "heading" });
        if (prefix === "> ") out.push({ start, end, style: "quote" });
      }
      inline(body, end);
    }
    start = end + 1;
  }
  return out;
}
function plain(node: Node): string {
  if (
    node instanceof HTMLElement &&
    node.classList.contains("rich-composer") &&
    node.textContent === ""
  )
    return "";
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node instanceof HTMLBRElement)
    return node.hasAttribute("data-sentinel") ? "" : "\n";
  let text = "";
  for (const child of node.childNodes) {
    if (
      child instanceof HTMLElement &&
      ["DIV", "P"].includes(child.tagName) &&
      text &&
      !text.endsWith("\n")
    )
      text += "\n";
    text += plain(child);
  }
  return text;
}

export function composer(element?: HTMLDivElement): Composer {
  const lifetime = new AbortController();
  const node = (element ||
    el("div", "composer-input rich-composer")) as Composer;
  node.contentEditable = "true";
  node.role = "textbox";
  node.setAttribute("aria-multiline", "true");
  node.spellcheck = true;
  let text = "",
    selectionStart = 0,
    selectionEnd = 0,
    disabled = false,
    composing = false,
    paintedLine = -1;
  type State = { text: string; start: number; end: number };
  const undo: State[] = [],
    redo: State[] = [];
  const line = (offset: number) => text.slice(0, offset).split("\n").length - 1;
  const capture = () => {
    const selection = getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (
      !node.contains(range.startContainer) ||
      !node.contains(range.endContainer)
    )
      return;
    const before = document.createRange();
    before.selectNodeContents(node);
    before.setEnd(range.startContainer, range.startOffset);
    selectionStart = plain(before.cloneContents()).length;
    before.setEnd(range.endContainer, range.endOffset);
    selectionEnd = plain(before.cloneContents()).length;
  };
  const select = (start: number, end: number) => {
    selectionStart = Math.max(0, Math.min(start, text.length));
    selectionEnd = Math.max(selectionStart, Math.min(end, text.length));
    if (document.activeElement !== node) return;
    const point = (offset: number): [Node, number] => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let current = walker.nextNode(),
        remaining = offset;
      while (current) {
        const length = current.textContent?.length || 0;
        if (remaining <= length) return [current, remaining];
        remaining -= length;
        current = walker.nextNode();
      }
      return [node, node.childNodes.length];
    };
    const range = document.createRange();
    range.setStart(...point(selectionStart));
    range.setEnd(...point(selectionEnd));
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  };
  const paint = () => {
    const top = node.scrollTop;
    const fragment = document.createDocumentFragment(),
      spans = draftSpans(text);
    const boundaries = [
      ...new Set([
        0,
        text.length,
        ...spans.flatMap((span) => [span.start, span.end]),
      ]),
    ].sort((a, b) => a - b);
    const cursorLine = line(selectionEnd);
    paintedLine = cursorLine;
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i],
        end = boundaries[i + 1],
        styles = spans
          .filter((span) => span.start <= start && span.end >= end)
          .map((span) => span.style);
      if (!styles.length) {
        fragment.append(document.createTextNode(text.slice(start, end)));
        continue;
      }
      const span = el(
        "span",
        styles.map((style) => "draft-" + style).join(" "),
        text.slice(start, end),
      );
      const marker = text.slice(start, end),
        kept = /^(?:\x60\x60\x60|[-*] |\d+\. )/.test(marker);
      if (styles.includes("marker") && !kept && line(start) !== cursorLine)
        span.hidden = true;
      fragment.append(span);
    }
    if (!text || text.endsWith("\n")) {
      const sentinel = el("br");
      sentinel.setAttribute("data-sentinel", "");
      fragment.append(sentinel);
    }
    node.replaceChildren(fragment);
    select(selectionStart, selectionEnd);
    node.scrollTop = top;
  };
  const remember = () => {
    capture();
    undo.push({ text, start: selectionStart, end: selectionEnd });
    if (undo.length > 100) undo.shift();
    redo.length = 0;
  };
  const changed = () =>
    node.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
  const replace = (value: string, start: number, end: number, mode = "end") => {
    remember();
    text = text.slice(0, start) + value + text.slice(end);
    const a =
        mode === "start"
          ? start
          : mode === "select"
            ? start
            : start + value.length,
      b = mode === "select" ? start + value.length : a;
    selectionStart = a;
    selectionEnd = b;
    paint();
    changed();
  };
  const history = (back: boolean) => {
    capture();
    const from = back ? undo : redo,
      to = back ? redo : undo,
      previous = from.pop();
    if (!previous) return;
    to.push({ text, start: selectionStart, end: selectionEnd });
    text = previous.text;
    selectionStart = previous.start;
    selectionEnd = previous.end;
    paint();
    changed();
  };
  Object.defineProperties(node, {
    value: {
      get: () => plain(node),
      set: (value: string) => {
        text = value;
        selectionStart = selectionEnd = text.length;
        undo.length = redo.length = 0;
        paint();
      },
    },
    selectionStart: {
      get: () => {
        capture();
        return selectionStart;
      },
    },
    selectionEnd: {
      get: () => {
        capture();
        return selectionEnd;
      },
    },
    disabled: {
      get: () => disabled,
      set: (value: boolean) => {
        disabled = value;
        node.contentEditable = String(!value);
        node.setAttribute("aria-disabled", String(value));
      },
    },
    placeholder: {
      get: () => node.dataset.placeholder || "",
      set: (value: string) => {
        node.dataset.placeholder = value;
      },
    },
  });
  node.setSelectionRange = (start, end) => {
    select(start, end);
    paint();
  };
  node.setRangeText = (value, start, end, mode) =>
    replace(value, start, end, mode);
  node.addEventListener(
    "beforeinput",
    (event) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      if (
        event.inputType === "insertParagraph" ||
        event.inputType === "insertLineBreak"
      ) {
        event.preventDefault();
        capture();
        replace("\n", selectionStart, selectionEnd);
        return;
      }
      if (
        event.inputType === "historyUndo" ||
        event.inputType === "historyRedo"
      ) {
        event.preventDefault();
        history(event.inputType === "historyUndo");
        return;
      }
      if (!composing) remember();
    },
    { signal: lifetime.signal },
  );
  node.addEventListener(
    "keydown",
    (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        history(!event.shiftKey);
      }
    },
    { signal: lifetime.signal },
  );
  node.addEventListener(
    "paste",
    (event) => {
      if (event.clipboardData?.files.length) return;
      event.preventDefault();
      capture();
      replace(
        event.clipboardData?.getData("text/plain") || "",
        selectionStart,
        selectionEnd,
      );
    },
    { signal: lifetime.signal },
  );
  node.addEventListener(
    "compositionstart",
    () => {
      remember();
      composing = true;
    },
    { signal: lifetime.signal },
  );
  node.addEventListener(
    "compositionend",
    () => {
      composing = false;
      text = plain(node);
      capture();
      paint();
    },
    { signal: lifetime.signal },
  );
  node.addEventListener(
    "input",
    () => {
      text = plain(node);
      capture();
      if (!composing) paint();
    },
    { signal: lifetime.signal },
  );
  let selectionEvents: AbortController | undefined;
  node.addEventListener(
    "focus",
    () => {
      select(selectionStart, selectionEnd);
      selectionEvents?.abort();
      selectionEvents = new AbortController();
      document.addEventListener(
        "selectionchange",
        () => {
          capture();
          if (!composing && line(selectionEnd) !== paintedLine) paint();
        },
        { signal: selectionEvents.signal },
      );
    },
    { signal: lifetime.signal },
  );
  node.addEventListener("blur", () => selectionEvents?.abort(), {
    signal: lifetime.signal,
  });
  node.dispose = () => {
    selectionEvents?.abort();
    lifetime.abort();
  };
  paint();
  return node;
}
