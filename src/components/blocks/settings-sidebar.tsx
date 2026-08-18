"use client";

// Settings-mode left navigation: swaps in for the TeamRun run list while the
// settings page is open. Visual language mirrors team-sidebar (same width,
// tokens, drag regions, brand header); the run list gives way to the five
// settings sections.

import { ArrowLeft, Bot, Settings } from "lucide-react";
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "@/features/settings/sections";
import { cn } from "@/lib/utils";

export function SettingsSidebar({
  active,
  onSelect,
  onExit,
}: {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
  onExit: () => void;
}) {
  return (
    <aside className="bg-sidebar text-sidebar-foreground border-sidebar-border app-drag flex h-full w-64 shrink-0 flex-col border-r">
      <div className="flex items-center gap-2.5 px-4 pb-4 pt-11">
        <div className="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-md">
          <Bot className="size-4.5" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold">OctoPunk</p>
          <p className="text-muted-foreground font-mono text-xs">Git Agent Team</p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 px-4 pt-2 pb-2">
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wider uppercase">
          <Settings className="size-3.5" />
          设置
        </span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-1">
        {SETTINGS_SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onSelect(section.id)}
              className={cn(
                "app-no-drag flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                active === section.id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60",
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{section.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="border-sidebar-border border-t p-2">
        <button
          type="button"
          onClick={onExit}
          className="text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground app-no-drag flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors"
        >
          <ArrowLeft className="size-4" />
          返回 TeamRun
        </button>
      </div>
    </aside>
  );
}
