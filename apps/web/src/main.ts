import "./gtk.css";
import "./style.css";
import "./extra.css";
import { App } from "./app";
import { toast } from "./dom";
localStorage.removeItem("rv-text-size");
const app = new App();
void app.init().catch(toast);
if ("serviceWorker" in navigator)
  void navigator.serviceWorker.register("/sw.js").catch(toast);
