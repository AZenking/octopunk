// Theme manager: light / dark / system with localStorage persistence.

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "octopunk.theme";

export function readThemeMode(): ThemeMode {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(mode: ThemeMode): void {
  const dark = mode === "dark" || (mode === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

export function saveThemeMode(mode: ThemeMode): void {
  localStorage.setItem(STORAGE_KEY, mode);
  applyTheme(mode);
}

/** Call once at app start; also tracks OS changes while in system mode. */
export function initTheme(): () => void {
  applyTheme(readThemeMode());
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = (): void => {
    if (readThemeMode() === "system") applyTheme("system");
  };
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
