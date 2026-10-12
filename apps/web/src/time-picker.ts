import { el, button, confirmationDialog } from "./dom";
import { iconButton } from "./icons";
import { language, t } from "./i18n";
import { nt } from "./native-i18n";

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
  const [node, actions] = confirmationDialog(words.title, words.hint);
  node.classList.add("time-picker-dialog");
  const content = el("div", "time-picker-content");
  node.querySelector(".confirmation-message")!.append(content);
  const calendar = el("div", "time-calendar"),
    heading = el("div", "calendar-heading"),
    monthTitle = el("span", "calendar-month"),
    yearTitle = el("span", "calendar-year");
  const grid = el("div", "calendar-grid");
  const spin = (maximum: number, value: number, label: string) => {
    const group = el("div", "time-spin-group"),
      input = el("input", "time-spin");
    input.type = "number";
    input.min = "0";
    input.max = String(maximum);
    input.value = String(value).padStart(2, "0");
    input.setAttribute("aria-label", label);
    const adjust = (delta: number) => {
      const value = Number(input.value);
      input.value = String(
        ((Number.isFinite(value) ? value : 0) + delta + maximum + 1) %
          (maximum + 1),
      ).padStart(2, "0");
      input.dispatchEvent(new Event("input"));
    };
    group.append(
      input,
      button("−", () => adjust(-1), "time-spin-step"),
      button("+", () => adjust(1), "time-spin-step"),
    );
    group.children[1].setAttribute(
      "aria-label",
      (language === "fr" ? "Diminuer " : "Decrease ") + label,
    );
    group.children[2].setAttribute(
      "aria-label",
      (language === "fr" ? "Augmenter " : "Increase ") + label,
    );
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        adjust(event.key === "ArrowUp" ? 1 : -1);
      }
    });
    return { group, input };
  };
  const hours = spin(
    23,
    initial.getHours(),
    language === "fr" ? "Heure" : "Hour",
  );
  const minutes = spin(
    59,
    initial.getMinutes(),
    language === "fr" ? "Minute" : "Minute",
  );
  const hour = hours.input,
    minute = minutes.input;
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
    "suggested time-picker-confirm",
  );
  const check = () => {
    confirm.disabled =
      !hour.checkValidity() ||
      !minute.checkValidity() ||
      !accepted(instant(), new Date());
  };
  const paint = () => {
    monthTitle.textContent = month.toLocaleDateString(language, {
      month: "long",
    });
    yearTitle.textContent = String(month.getFullYear());
    grid.replaceChildren();
    const firstWeekday = language === "fr" ? 1 : 0;
    for (let index = 0; index < 7; index++) {
      const day = new Date(2026, 0, 4 + firstWeekday + index);
      grid.append(
        el(
          "span",
          "calendar-weekday",
          day.toLocaleDateString(language, { weekday: "short" }),
        ),
      );
    }
    const offset = (month.getDay() - firstWeekday + 7) % 7;
    for (let index = 0; index < 42; index++) {
      const at = new Date(
        month.getFullYear(),
        month.getMonth(),
        1 + index - offset,
      );
      const entry = button(
        String(at.getDate()),
        () => {
          selected = at;
          if (at.getMonth() !== month.getMonth())
            month = new Date(at.getFullYear(), at.getMonth(), 1);
          paint();
          check();
        },
        "flat calendar-day" +
          (at.getMonth() !== month.getMonth() ? " other-month" : ""),
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
  const months = el("div", "calendar-month-controls"),
    years = el("div", "calendar-year-controls");
  months.append(
    iconButton(
      "back",
      language === "fr" ? "Mois précédent" : "Previous month",
      () => {
        month.setMonth(month.getMonth() - 1);
        paint();
      },
    ),
    monthTitle,
    iconButton(
      "arrow",
      language === "fr" ? "Mois suivant" : "Next month",
      () => {
        month.setMonth(month.getMonth() + 1);
        paint();
      },
    ),
  );
  years.append(
    iconButton(
      "back",
      language === "fr" ? "Année précédente" : "Previous year",
      () => {
        month.setFullYear(month.getFullYear() - 1);
        paint();
      },
    ),
    yearTitle,
    iconButton(
      "arrow",
      language === "fr" ? "Année suivante" : "Next year",
      () => {
        month.setFullYear(month.getFullYear() + 1);
        paint();
      },
    ),
  );
  heading.append(months, years);
  calendar.append(heading, grid);
  const clock = el("div", "time-clock");
  clock.append(
    el("span", "", nt("scheduled.time")),
    hours.group,
    el("span", "", ":"),
    minutes.group,
  );
  actions.append(
    button(t("cancel"), () => node.close()),
    confirm,
  );
  content.append(calendar, clock);
  hour.addEventListener("input", check);
  minute.addEventListener("input", check);
  paint();
  check();
  confirm.focus();
}
