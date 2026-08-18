// Selectable code (syntax) themes for the Markdown renderer. Each entry pairs
// a shiki light + dark theme; the app theme picks the side at render time via
// the existing --shiki-light/--shiki-dark CSS variables.

export interface CodeTheme {
  id: string;
  label: string;
  light: string;
  dark: string;
}

const STORAGE_KEY = "octopunk.codeTheme";
const CHANGE_EVENT = "octopunk:code-theme-changed";

export const CODE_THEMES: readonly CodeTheme[] = [
  { id: "github", label: "GitHub", light: "github-light-default", dark: "github-dark-default" },
  { id: "one", label: "One Dark Pro", light: "one-light", dark: "one-dark-pro" },
  { id: "vitesse", label: "Vitesse", light: "vitesse-light", dark: "vitesse-dark" },
  { id: "min", label: "Min", light: "min-light", dark: "min-dark" },
  { id: "catppuccin", label: "Catppuccin", light: "catppuccin-latte", dark: "catppuccin-mocha" },
  { id: "rose-pine", label: "Rosé Pine", light: "rose-pine-dawn", dark: "rose-pine-moon" },
] as const;

export const DEFAULT_CODE_THEME: CodeTheme = CODE_THEMES[0];

export function readCodeTheme(): CodeTheme {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    return CODE_THEMES.find((theme) => theme.id === id) ?? DEFAULT_CODE_THEME;
  } catch {
    return DEFAULT_CODE_THEME;
  }
}

export function saveCodeTheme(id: string): void {
  const theme = CODE_THEMES.find((entry) => entry.id === id) ?? DEFAULT_CODE_THEME;
  try {
    localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {
    // Storage unavailable; the in-memory choice still applies this session.
  }
  window.dispatchEvent(new CustomEvent<string>(CHANGE_EVENT, { detail: theme.id }));
}

export function subscribeCodeTheme(listener: (id: string) => void): () => void {
  const handler = (event: Event): void => {
    listener((event as CustomEvent<string>).detail);
  };
  window.addEventListener(CHANGE_EVENT, handler);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
  };
}
