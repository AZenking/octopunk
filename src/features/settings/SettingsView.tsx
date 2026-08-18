// Settings detail view: section header (title + description) driven by the
// settings sidebar selection, content delegated to per-section components.

import { useAppState } from "@/appState";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  SETTINGS_SECTIONS,
  type SettingsSection,
} from "@/features/settings/sections";
import { GeneralSettings } from "@/features/settings/sections/GeneralSettings";
import { AppearanceSettings } from "@/features/settings/sections/AppearanceSettings";
import { AgentsSettings } from "@/features/settings/sections/AgentsSettings";
import { ConnectionsSettings } from "@/features/settings/sections/ConnectionsSettings";
import { CustomSettings } from "@/features/settings/sections/CustomSettings";

export function SettingsView({ section }: { section: SettingsSection }) {
  const appState = useAppState();
  const meta =
    SETTINGS_SECTIONS.find((entry) => entry.id === section) ?? SETTINGS_SECTIONS[0];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-border flex items-start gap-3 border-b px-8 py-6">
        <SidebarTrigger className="mt-1" />
        <div>
          <h1 className="text-foreground text-xl font-semibold">设置 · {meta.label}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{meta.description}</p>
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl px-8 py-6">
        {section === "general" ? (
          <GeneralSettings />
        ) : section === "appearance" ? (
          <AppearanceSettings />
        ) : section === "agents" ? (
          <AgentsSettings />
        ) : section === "connections" ? (
          <ConnectionsSettings />
        ) : (
          <CustomSettings />
        )}

        {appState.statusMessage != null && (
          <p className="text-muted-foreground mt-6 text-xs">{appState.statusMessage}</p>
        )}
      </div>
    </div>
  );
}
