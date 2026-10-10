import "./gtk.css";
import "./style.css";
import "./extra.css";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Application } from "./ui/application";
import { App } from "./app";
import { toast } from "./dom";
localStorage.removeItem("rv-text-size");
const app = new App();
const root = createRoot(document.querySelector<HTMLDivElement>("#app")!);
root.render(createElement(Application, { app }));
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
if (!import.meta.env.DEV && "serviceWorker" in navigator)
  void navigator.serviceWorker.register("/sw.js").catch(toast);
