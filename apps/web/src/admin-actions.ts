export const administration = (
  ...args: Parameters<typeof import("./admin").administration>
) => import("./admin").then((panel) => panel.administration(...args));
export const report = (...args: Parameters<typeof import("./admin").report>) =>
  import("./admin").then((panel) => panel.report(...args));
