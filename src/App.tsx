import { useEffect } from "react";
import { TeamDashboardView } from "./features/dashboard/TeamDashboardView";
import { AppStateProvider } from "./appState";
import { initTheme } from "./lib/theme";

export default function App() {
  useEffect(() => initTheme(), []);
  return (
    <AppStateProvider>
      <TeamDashboardView />
    </AppStateProvider>
  );
}
