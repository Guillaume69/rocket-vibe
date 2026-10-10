import { renderView } from "./portals";
export function entryControl(
  row: HTMLElement,
  title: string,
  value: string,
  change: (value: string) => void,
  area: boolean,
): void {
  const props = {
    className: "pill-entry",
    "aria-label": title,
    defaultValue: value,
    onInput: (event: React.FormEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      change(event.currentTarget.value),
  };
  renderView(
    row,
    <>
      <span className="action-row-title">{title}</span>
      {area ? <textarea {...props} /> : <input {...props} />}
    </>,
  );
}
export function selectControl(
  row: HTMLElement,
  title: string,
  value: string,
  options: readonly (readonly [string, string])[],
  change: (value: string) => void,
): void {
  renderView(
    row,
    <>
      <span className="action-row-title">{title}</span>
      <select
        className="pill-entry"
        aria-label={title}
        defaultValue={value}
        onChange={(event) => change(event.currentTarget.value)}
      >
        {options.map(([id, name]) => (
          <option key={id} value={id}>
            {name}
          </option>
        ))}
      </select>
    </>,
  );
}
export function switchControl(
  row: HTMLElement,
  title: string,
  value: boolean,
  change: (value: boolean) => void,
): void {
  renderView(
    row,
    <>
      <span className="action-row-title">{title}</span>
      <input
        type="checkbox"
        aria-label={title}
        defaultChecked={value}
        onChange={(event) => change(event.currentTarget.checked)}
      />
    </>,
  );
}
