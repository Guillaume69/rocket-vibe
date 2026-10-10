import { createContext, useContext } from "react";
import type { App } from "../app";

export const AppContext = createContext<App | null>(null);
export function useApp(): App {
  const app = useContext(AppContext);
  if (!app) throw new Error("Application context is unavailable");
  return app;
}
