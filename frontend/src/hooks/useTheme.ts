import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "ew_theme";

const listeners = new Set<() => void>();
const darkQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function readStored(): ThemeMode {
  const value = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
  return value === "dark" || value === "light" || value === "system" ? value : "system";
}

let mode: ThemeMode = readStored();

function resolve(next: ThemeMode): boolean {
  return next === "dark" || (next === "system" && (darkQuery?.matches ?? false));
}

function apply() {
  document.documentElement.classList.toggle("dark", resolve(mode));
}

if (typeof document !== "undefined") {
  apply();

  darkQuery?.addEventListener("change", () => {
    if (mode === "system") {
      apply();
      listeners.forEach((l) => l());
    }
  });
}

export function setTheme(next: ThemeMode) {
  mode = next;
  localStorage.setItem(STORAGE_KEY, next);
  apply();
  listeners.forEach((l) => l());
}

export function useTheme() {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => mode,
    () => "system" as ThemeMode,
  );

  return { theme, setTheme, isDark: resolve(theme) };
}
