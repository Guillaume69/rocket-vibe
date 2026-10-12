import { el, button, dialog } from "./dom";
import { iconButton } from "./icons";
import { language, t } from "./i18n";

/** GTK Calendar and two numeric time fields, shared by schedules and reminders. */
export function pickTimeDialog(
  words: { title: string; hint: string; confirm: string },
  accepted: (at: Date, now: Date) => boolean,
  chosen: (at: Date) => Promise<void>,
): void {
  const initial = new Date(Date.now() + 3600000);
  initial.setMinutes(
    initial.getMinutes() + ((15 - (initial.getMinutes() % 15)) % 15),
    0,
    0,
  );
  let selected = new Date(initial),
    month = new Date(initial.getFullYear(), initial.getMonth(), 1);
  const [node, body] = dialog(words.title);
  node.classList.add("time-picker-dialog");
  body.append(el("p", "details-sub", words.hint));
  const calendar = el("div", "time-calendar"),
    heading = el("div", "calendar-heading"),
    title = el("span", "");
  const grid = el("div", "calendar-grid");
  const spin = (maximum: number, value: number, label: string) => {
    const input = el("input", "pill-entry time-spin");
    input.type = "number";
    input.min = "0";
    input.max = String(maximum);
    input.value = String(value).padStart(2, "0");
    input.setAttribute("aria-label", label);
    return input;
  };
  const hour = spin(
    23,
    initial.getHours(),
    language === "fr" ? "Heure" : "Hour",
  );
  const minute = spin(
    59,
    initial.getMinutes(),
    language === "fr" ? "Minute" : "Minute",
  );
  const instant = () => {
    const value = new Date(selected);
    value.setHours(Number(hour.value), Number(minute.value), 0, 0);
    return value;
  };
  const confirm = button(
    words.confirm,
    async () => {
      const at = instant();
      if (!accepted(at, new Date())) return;
      await chosen(at);
      node.close();
    },
    "suggested",
  );
  const check = () => {
    confirm.disabled =
      !hour.checkValidity() ||
      !minute.checkValidity() ||
      !accepted(instant(), new Date());
  };
  const paint = () => {
    title.textContent = month.toLocaleDateString(language, {
      month: "long",
      year: "numeric",
    });
    grid.replaceChildren();
    for (let index = 0; index < 7; index++) {
      const day = new Date(2026, 0, 5 + index);
      grid.append(
        el(
          "span",
          "calendar-weekday",
          day.toLocaleDateString(language, { weekday: "short" }),
        ),
      );
    }
    const offset = (month.getDay() + 6) % 7;
    const count = new Date(
      month.getFullYear(),
      month.getMonth() + 1,
      0,
    ).getDate();
    for (let index = 0; index < offset; index++) grid.append(el("span"));
    for (let day = 1; day <= count; day++) {
      const at = new Date(month.getFullYear(), month.getMonth(), day);
      const entry = button(
        String(day),
        () => {
          selected = at;
          paint();
          check();
        },
        "flat calendar-day",
      );
      entry.setAttribute(
        "aria-label",
        at.toLocaleDateString(language, {
          year: "numeric",
          month: "long",
          day: "numeric",
        }),
      );
      entry.setAttribute(
        "aria-pressed",
        String(at.toDateString() === selected.toDateString()),
      );
      grid.append(entry);
    }
  };
  heading.append(
    iconButton(
      "back",
      language === "fr" ? "Mois précédent" : "Previous month",
      () => {
        month.setMonth(month.getMonth() - 1);
        paint();
      },
    ),
    title,
    iconButton(
      "arrow",
      language === "fr" ? "Mois suivant" : "Next month",
      () => {
        month.setMonth(month.getMonth() + 1);
        paint();
      },
    ),
  );
  calendar.append(heading, grid);
  const clock = el("div", "time-clock");
  clock.append(hour, el("span", "", ":"), minute);
  const actions = el("div", "time-picker-actions");
  actions.append(
    button(t("cancel"), () => node.close()),
    confirm,
  );
  body.append(calendar, clock, actions);
  hour.addEventListener("input", check);
  minute.addEventListener("input", check);
  paint();
  check();
}
