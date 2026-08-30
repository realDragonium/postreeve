import { useEffect, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ThemeMode = "light" | "dark";

const storageKey = "postreeve.theme";

/** Rails colour accounts consistently across the sidebar, list and reader. */
export const railCount = 6;

export function railFor(accountId: string): string {
  let hash = 0;
  for (const character of accountId) hash = (hash * 31 + character.codePointAt(0)!) % 100_003;
  return `var(--hue-${hash % railCount})`;
}

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Private-mode browsers reject storage access; the system default still works.
  }
  return "system";
}

export function useTheme(): {
  preference: ThemePreference;
  mode: ThemeMode;
  setPreference: (next: ThemePreference) => void;
} {
  const [preference, setStoredPreference] = useState<ThemePreference>(readPreference);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }, []);

  const mode: ThemeMode = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  return {
    preference,
    mode,
    setPreference: (next) => {
      setStoredPreference(next);
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        // Preference stays for this session only when storage is unavailable.
      }
    },
  };
}
