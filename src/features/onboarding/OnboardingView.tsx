// Port of OctoPunk/OctoPunk/Features/Onboarding/OnboardingView.swift.

import { Network } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function OnboardingView() {
  return (
    <Card className="m-7 w-fit gap-2 py-4">
      <CardContent className="flex flex-col gap-3 px-4">
        <span className="flex items-center gap-2 text-lg font-semibold">
          <Network aria-hidden />
          OctoPunk 0.2
        </span>
        <p className="text-muted-foreground max-w-prose text-sm">
          Codex remains the primary agent. OctoPunk persists team state, starts explicitly selected
          Claude Code or Codex child sessions, and exposes the review loop through MCP.
        </p>
        <p className="text-muted-foreground font-mono text-xs">
          SQLite database: ~/Library/Application Support/OctoPunk/octopunk.sqlite
        </p>
      </CardContent>
    </Card>
  );
}
