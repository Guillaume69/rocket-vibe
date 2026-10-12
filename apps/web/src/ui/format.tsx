import { Fragment } from "react";
import type { App } from "../app";
import type { Composer } from "../composer";
import { nt } from "../native-i18n";
import { ActionButton, Symbol } from "./controls";

type Format =
  | "bold"
  | "italic"
  | "strike"
  | "heading"
  | "link"
  | "code"
  | "code_block"
  | "quote"
  | "bullets"
  | "numbers";
const items: [Format, string, string?][] = [
  ["bold", "B", "bold"],
  ["italic", "I", "italic"],
  ["strike", "S", "strike"],
  ["heading", "H"],
  ["link", ""],
  ["code", "</>"],
  ["code_block", "{ }"],
  ["quote", "“"],
  ["bullets", ""],
  ["numbers", ""],
];

/** GTK's toolbar edits the selection in place, including a selected link address. */
export function formatDraft(editor: Composer, kind: Format): void {
  const text = editor.value,
    a = editor.selectionStart,
    b = editor.selectionEnd;
  let left = a,
    right = b,
    replacement = "",
    start = a,
    end = b;
  const selected = text.slice(a, b);
  const marker = { bold: "*", italic: "_", strike: "~", code: "`" }[
    kind as "bold" | "italic" | "strike" | "code"
  ];
  if (marker) {
    if (
      a < b &&
      text.slice(a - marker.length, a) === marker &&
      text.slice(b, b + marker.length) === marker
    ) {
      left -= marker.length;
      right += marker.length;
      replacement = selected;
      start = left;
      end = b - marker.length;
    } else if (
      selected.startsWith(marker) &&
      selected.endsWith(marker) &&
      selected.length >= marker.length * 2
    ) {
      replacement = selected.slice(marker.length, -marker.length);
      end = start + replacement.length;
    } else {
      replacement = marker + selected + marker;
      start += marker.length;
      end += marker.length;
    }
  } else if (kind === "link") {
    replacement = "[" + selected + "](https://)";
    start = a + selected.length + 3;
    end = start + 8;
  } else if (kind === "code_block") {
    const before = a > 0 && text[a - 1] !== "\n" ? "\n" : "";
    const after = b < text.length && text[b] !== "\n" ? "\n" : "";
    replacement = before + "```\n" + selected + "\n```" + after;
    start = a + before.length + 4;
    end = start + selected.length;
  } else {
    left = text.lastIndexOf("\n", a - 1) + 1;
    const boundary = text.indexOf("\n", b);
    right = boundary < 0 ? text.length : boundary;
    const prefix = { heading: "# ", quote: "> ", bullets: "- ", numbers: "" }[
      kind as "heading" | "quote" | "bullets" | "numbers"
    ];
    const lines = text.slice(left, right).split("\n");
    const existing = (line: string) =>
      kind === "numbers"
        ? /^\d+\. /.exec(line)?.[0]
        : line.startsWith(prefix)
          ? prefix
          : undefined;
    const all = lines.every((line) => existing(line));
    let firstDelta = 0;
    replacement = lines
      .map((line, index) => {
        const old = existing(line),
          added = kind === "numbers" ? `${index + 1}. ` : prefix;
        const next =
          all && old ? line.slice(old.length) : old ? line : added + line;
        if (index === 0) firstDelta = next.length - line.length;
        return next;
      })
      .join("\n");
    start = Math.max(left, a + firstDelta);
    end = Math.max(left, b + replacement.length - (right - left));
  }
  editor.setRangeText(replacement, left, right, "select");
  editor.focus();
  editor.setSelectionRange(start, end);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

export function formatShortcut(
  editor: Composer,
  event: KeyboardEvent,
): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  const key = event.key.toLowerCase();
  const kind =
    key === "b"
      ? "bold"
      : key === "i"
        ? "italic"
        : key === "x" && event.shiftKey
          ? "strike"
          : key === "k" && event.shiftKey
            ? "link"
            : key === "e"
              ? event.shiftKey
                ? "code_block"
                : "code"
              : event.shiftKey && (key === "7" || key === "&")
                ? "numbers"
                : event.shiftKey && (key === "8" || key === "*")
                  ? "bullets"
                  : event.shiftKey && (key === "9" || key === "(")
                    ? "quote"
                    : undefined;
  if (!kind) return false;
  event.preventDefault();
  formatDraft(editor, kind);
  return true;
}

export function ComposerFormatBar({
  app,
  disabled = false,
  thread = false,
}: {
  app: App;
  disabled?: boolean;
  thread?: boolean;
}) {
  return (
    <div className="format-bar" hidden={disabled}>
      {items.map(([kind, label, style], index) => (
        <Fragment key={kind}>
          {(index === 3 || index === 7) && (
            <span className="format-separator" aria-hidden="true" />
          )}
          <ActionButton
            className={"flat format-button " + (style || "")}
            title={nt("format." + kind)}
            aria-label={nt("format." + kind)}
            onMouseDown={(event) => event.preventDefault()}
            action={() =>
              formatDraft(thread ? app.threadComposer : app.composer, kind)
            }
          >
            {kind === "link" ? (
              <Symbol name="link" />
            ) : kind === "bullets" ? (
              <Symbol name="bullets" />
            ) : kind === "numbers" ? (
              <Symbol name="numbers" />
            ) : (
              label
            )}
          </ActionButton>
        </Fragment>
      ))}
    </div>
  );
}
