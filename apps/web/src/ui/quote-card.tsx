import type { ReactNode } from "react";
import type { FileDescriptor, MessageQuote } from "../protocol";
import { inlineImage } from "../image-attachment";
import { nt } from "../native-i18n";
import { Symbol } from "./controls";

/** GTK cards.rs: passive author, nested quotes, Markdown and ordinary files. */
export function QuoteCard({
  quote,
  text,
  image,
  depth = 1,
  path = [],
}: {
  quote: MessageQuote;
  text(value: string): ReactNode;
  image(file: FileDescriptor): ReactNode;
  depth?: number;
  path?: string[];
}) {
  const key = JSON.stringify([
      quote.reference.room_id,
      quote.reference.message_id,
    ]),
    excerpt = path.includes(key) ? null : quote.excerpt;
  return (
    <blockquote className="quote-card">
      {!excerpt ? (
        <div className="quote-text quote-unavailable">
          {nt("quote.unavailable")}
        </div>
      ) : (
        <>
          <div className="quote-author">
            {excerpt.author.display_name || excerpt.author.username}
          </div>
          {depth < 2 &&
            (excerpt.quotes ?? []).map((nested, index) => (
              <QuoteCard
                key={index}
                quote={nested}
                text={text}
                image={image}
                depth={depth + 1}
                path={[...path, key]}
              />
            ))}
          {excerpt.text.trim() && (
            <div className="quote-text">{text(excerpt.text)}</div>
          )}
          {(excerpt.files ?? [])
            .filter((file) => !file.encrypted)
            .map((file) =>
              inlineImage(file) ? (
                image(file)
              ) : (
                <div
                  className="quote-file"
                  key={file.id}
                  data-file-id={file.id}
                >
                  <Symbol
                    name={
                      file.media_type.startsWith("audio/")
                        ? "audio-file"
                        : file.media_type.startsWith("video/")
                          ? "video"
                          : "attach"
                    }
                  />
                  <span className="quote-text">
                    {file.filename || file.media_type}
                  </span>
                </div>
              ),
            )}
        </>
      )}
    </blockquote>
  );
}
