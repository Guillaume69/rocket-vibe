import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
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
    proxy: {
      "/api": { target: backend, ws: true },
      "/.well-known/rocketvibe": { target: backend },
    },
  },
  build: { target: "es2022" },
});
