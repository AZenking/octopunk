// 外观 — app theme (light/dark/system) and code-highlight theme.

import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { readThemeMode, saveThemeMode, type ThemeMode } from "@/lib/theme";
import {
  CODE_THEMES,
  readCodeTheme,
  saveCodeTheme,
} from "@/lib/codeTheme";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Row, RowGroup, SectionLabel } from "@/features/settings/parts";

export function AppearanceSettings() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readThemeMode());
  const [codeTheme, setCodeTheme] = useState(() => readCodeTheme());

  return (
    <div className="flex flex-col gap-8">
      <section>
        <SectionLabel>应用主题</SectionLabel>
        <RowGroup>
          <Row
            title="主题"
            desc="界面配色跟随浅色/深色或系统"
            control={
              <div className="bg-muted/60 border-border inline-flex items-center gap-0.5 rounded-lg border p-0.5">
                {(
                  [
                    { id: "light", label: "浅色", icon: <Sun className="size-3.5" /> },
                    { id: "dark", label: "深色", icon: <Moon className="size-3.5" /> },
                    { id: "system", label: "系统", icon: <Monitor className="size-3.5" /> },
                  ] as { id: ThemeMode; label: string; icon: React.ReactNode }[]
                ).map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => {
                      setThemeMode(option.id);
                      saveThemeMode(option.id);
                    }}
                    className={
                      "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors " +
                      (themeMode === option.id
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground")
                    }
                  >
                    {option.icon}
                    {option.label}
                  </button>
                ))}
              </div>
            }
          />
        </RowGroup>
      </section>

      <section>
        <SectionLabel>代码主题</SectionLabel>
        <RowGroup>
          <Row
            title="代码高亮"
            desc="子 Agent 输出中代码块的配色"
            hint="浅色/深色两套配色随应用主题自动切换，对已有代码块立即生效。"
            control={
              <Select
                value={codeTheme.id}
                onValueChange={(value) => {
                  const next = CODE_THEMES.find((theme) => theme.id === value);
                  if (next == null) return;
                  setCodeTheme(next);
                  saveCodeTheme(next.id);
                }}
              >
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CODE_THEMES.map((theme) => (
                    <SelectItem key={theme.id} value={theme.id}>
                      {theme.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </RowGroup>
      </section>
    </div>
  );
}
