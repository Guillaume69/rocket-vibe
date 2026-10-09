import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const backend = process.env.RV_WEB_API_URL || "http://127.0.0.1:3400";
export default defineConfig({
  plugins: [
    {
      name: "normalize-text-assets",
      enforce: "pre",
      load(id) {
        if (id.endsWith("?raw"))
          return (
            "export default " +
            JSON.stringify(
              readFileSync(id.slice(0, -4), "utf8").replaceAll("\r\n", "\n"),
            ) +
            ";"
          );
      },
    },
  ],
  server: {
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(
          new URL("../desktop/crates/rv-gtk/assets/fonts/", import.meta.url),
        ),
        fileURLToPath(new URL("../../assets/sounds/", import.meta.url)),
        fileURLToPath(
          new URL("../desktop/crates/rv-core/data/", import.meta.url),
        ),
      ],
    },
    proxy: {
      "/api": { target: backend, ws: true },
      "/.well-known/rocketvibe": { target: backend },
    },
  },
  build: { target: "es2022" },
});
