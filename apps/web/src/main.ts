import "./gtk.css";
import "./style.css";
import "./extra.css";
import { App } from "./app";
import { toast } from "./dom";
document.documentElement.style.setProperty(
  "--text-scale",
  String(Number(localStorage.getItem("rv-text-size") || "100") / 100),
);
const app = new App();
void app.init().catch(toast);
if ("serviceWorker" in navigator)
  void navigator.serviceWorker.register("/sw.js").catch(toast);
