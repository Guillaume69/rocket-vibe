export const newConversation = (
  ...args: Parameters<typeof import("./panels").newConversation>
) => import("./panels").then((panel) => panel.newConversation(...args));
export const search = (...args: Parameters<typeof import("./panels").search>) =>
  import("./panels").then((panel) => panel.search(...args));
export const marked = (...args: Parameters<typeof import("./panels").marked>) =>
  import("./panels").then((panel) => panel.marked(...args));
export const profile = (
  ...args: Parameters<typeof import("./panels").profile>
) => import("./panels").then((panel) => panel.profile(...args));
export const roomInfo = (
  ...args: Parameters<typeof import("./panels").roomInfo>
) => import("./panels").then((panel) => panel.roomInfo(...args));
export const settings = (
  ...args: Parameters<typeof import("./panels").settings>
) => import("./panels").then((panel) => panel.settings(...args));
