import { STARS } from "./design.generated";
import { el } from "./dom";
export function sky(): HTMLElement {
  const sky = el("div", "stars");
  for (const [x, y, r, red, green, blue, alpha] of STARS) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("sparkle");
    svg.setAttribute("viewBox", "-1 -1 2 2");
    svg.style.left = x * 100 + "%";
    svg.style.top = y * 100 + "%";
    svg.style.width = svg.style.height = 2 * r * 1.4 + "px";
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute(
      "d",
      "M0 -1 C.18 -.18 .18 -.18 1 0 C.18 .18 .18 .18 0 1 C-.18 .18 -.18 .18 -1 0 C-.18 -.18 -.18 -.18 0 -1 Z",
    );
    path.setAttribute(
      "fill",
      "rgba(" + [red * 255, green * 255, blue * 255, alpha].join(",") + ")",
    );
    svg.append(path);
    sky.append(svg);
  }
  return sky;
}
