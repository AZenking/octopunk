// Bundled OctoPunk skill content for orchestrating agents (Claude Code /
// Codex), adapted per target. Embedded as TypeScript so the compiled main
// bundle always carries it (tsc does not copy .md resources). The body follows
// the hand-maintained .zcode/skills/octopunk/SKILL.md; only the Connection
// section and the version marker are generated per install.

export type SkillTargetKind = "claude_code" | "codex" | "pi";

/** Bump when rendered content changes; installed copies compare against it. */
export const OCTOPUNK_SKILL_VERSION = 1;

export function parseSkillVersion(content: string): number | null {
  const match = /<!--\s*octopunk-skill-version:\s*(\d+)\s*-->/.exec(content);
  return match == null ? null : Number.parseInt(match[1], 10);
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shellQuote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}

const FRONTMATTER = `---
name: octopunk
description: Use the local OctoPunk MCP server to orchestrate controlled Claude or Codex sub-agent work, including TeamRuns, atomic batch delegation, parent and dependency trees, live task observation, join summaries, review, cancellation, resume, and Git worktree isolation. Trigger when the user asks to use OctoPunk, delegate sub-agents, run tasks in parallel, monitor child tasks, join results, or inspect execution logs.
---`;

const CONNECTION_FALLBACK = `If \`octopunk\` tools are not available, state that the MCP is not connected and ask the user to restart/reconnect the app or configure the server. Do not silently fall back to another MCP server such as \`relaydesk\`, and do not claim that a child task was started.`;

function connectionSection(kind: SkillTargetKind, command: string, args: string[]): string {
  if (kind === "claude_code") {
    const cli = [
      "claude",
      "mcp",
      "add",
      "-s",
      "user",
      "octopunk",
      "--",
      shellQuote(command),
      ...args.map(shellQuote),
    ].join(" ");
    return `## Connection

Skills under \`~/.claude/skills/\` are discovered automatically. To let Claude Code reach the local server, register the \`octopunk\` MCP once (user scope, stored in \`~/.claude.json\`):

\`\`\`bash
${cli}
\`\`\`

${CONNECTION_FALLBACK}`;
  }
  if (kind === "pi") {
    const config = JSON.stringify(
      {
        mcpServers: {
          octopunk: {
            command,
            args,
            transport: "stdio",
            lifecycle: "eager",
          },
        },
      },
      null,
      2,
    );
    return `## Connection

Skills under \`~/.pi/agent/skills/\` are discovered automatically. pi has no built-in MCP client, so first install the bridge extension (\`pi install npm:pi-mcp-extension\`), then merge this server into \`~/.pi/agent/mcp.json\` (create the file if missing; \`eager\` starts the server with every session):

\`\`\`json
${config}
\`\`\`

Verify with \`/mcp\` inside pi. ${CONNECTION_FALLBACK}`;
  }
  return `## Connection

Skills under \`~/.codex/skills/\` are discovered automatically. To let Codex reach the local server, register the \`octopunk\` MCP once in \`~/.codex/config.toml\` — or use OctoPunk → 设置 → 连接与 MCP → 连接 Codex, which writes (and backs up) the entry for you:

\`\`\`toml
[mcp_servers.octopunk]
command = ${tomlString(command)}
args = [${args.map(tomlString).join(", ")}]
\`\`\`

${CONNECTION_FALLBACK}`;
}

const BODY_TAIL = `## Operating workflow

1. Establish a TeamRun. If the user already supplied \`run_id\`, use it. Otherwise call \`start_team\` with the repository path, task description, and baseline information available from the repository. OctoPunk permits one active TeamRun; if creation is rejected because another run is active, report that fact and do not cancel or reuse it without explicit direction.

2. Select the execution contract explicitly. Use \`agent_kind: "claude_code"\` by default because Claude is the active production adapter; use \`codex\` or \`pi\` only when the user explicitly requests it and that adapter is enabled. Use \`execution_mode: "read_only"\` for investigations and audits, and \`workspace_write\` only for requested code changes.

3. For multiple children, call \`delegate_tasks\` once with the complete array. It is atomic: validate every item and reference before creation. Each item needs a unique \`client_key\`, title, prompt, agent kind, and execution mode. A \`parent_task\` or dependency reference must contain exactly one of \`task_id\` or same-batch \`client_key\`. Parentage controls hierarchy and context; only \`dependencies\` control execution order.

4. Include one redacted \`context_summary\` for the batch. Keep it at or below 16 KiB UTF-8, never include credentials, tokens, private keys, or unnecessary user data, and do not invoke another model to summarize it. OctoPunk stores an immutable context snapshot and injects it into each child prompt together with completed dependency reports and Git/permission constraints.

5. Let OctoPunk queue work above the concurrency limit; do not reject or manually emulate queued tasks. Use \`task_event\` notifications for activity when available, but treat persisted state and \`join_tasks\` as authoritative. Do not poll aggressively.

6. Join results with exactly one selector: \`batch_id\` or \`task_ids\`. Set \`timeout_seconds\` no higher than 45. A timeout returns a partial result and does not cancel children; call \`join_tasks\` again when the user wants the remaining results. Summarize status, report, elapsed time, tests, changed files, blocking reason, pending tasks, latest event sequence, and the deterministic Markdown returned by OctoPunk.

## Recommended MCP tools

- \`start_team\`: create the single TeamRun and capture its Git baseline.
- \`delegate_tasks\`: preferred atomic multi-task entry point; use \`delegate_task\` for a single child when convenient.
- \`join_tasks\`: wait for a batch or explicit task set without implicit cancellation.
- \`get_team_status\`: inspect the run and task states.
- \`get_task_execution_log\`: read only the bounded, redacted log tail and event summaries.
- \`get_task_review_context\`: inspect a task report before accepting or requesting rework.
- \`request_rework\`, \`accept_task\`, \`block_task\`: perform explicit review decisions.
- \`resume_task\`: retry explicitly using the existing native session where possible.
- \`cancel_task\`/\`cancel_team\`: stop work but retain resumable worktrees.
- \`discard_task\`/\`discard_team\`: permanently discard worktrees; use only when explicitly requested.
- \`complete_team\`: integrate only after the user-approved final review.

Never automatically accept, discard, retry, push, or complete a run. Never expose secrets through \`context_summary\`, task prompts, reports, or logs.

## Batch template

Use this shape for a read-only parallel investigation:

\`\`\`json
{
  "request_id": "unique-request-id",
  "run_id": "team-run-uuid",
  "context_summary": "Redacted goal, scope, repository and acceptance criteria.",
  "tasks": [
    {
      "client_key": "search-pages",
      "title": "Find affected pages",
      "prompt": "Inspect the repository read-only and report exact files, routes and evidence.",
      "agent_kind": "claude_code",
      "execution_mode": "read_only"
    },
    {
      "client_key": "verify-terms",
      "title": "Verify terminology",
      "prompt": "Audit the requested terminology read-only and return file/line evidence.",
      "agent_kind": "claude_code",
      "execution_mode": "read_only",
      "dependencies": [{"client_key": "search-pages"}]
    }
  ]
}
\`\`\`

For independent tasks, omit \`dependencies\`; for a child task, set \`parent_task\` separately. Do not use parentage as a substitute for a dependency.

## Safety and isolation

- Keep read-only tasks out of write branches and integration. OctoPunk shares a detached baseline worktree for read-only children within a TeamRun.
- Keep workspace-writing tasks in their own branch/worktree. Review before integration; never ask a child to commit, push, use Web/Computer tools, or create more agents.
- Claude children must remain isolated by \`--setting-sources ""\` and a minimal \`--tools\` allowlist. Codex recursion and MCP are disabled by the adapter. Do not try to bypass these controls in prompts.
- Cancellation is process-group termination with resumable worktree retention. Discard is destructive and cleans worktrees; explain what will be removed before using it.
- Never create recursive child tasks. The OctoPunk child configuration, not merely a prompt sentence, is the enforcement boundary.
- Do not promise automatic wake-up from notifications. HTTP clients use \`join_tasks\` as the fallback; STDIO notifications are an optimization.

## User-facing result

Report the \`run_id\`, \`batch_id\`, each \`client_key\`, status, elapsed time, and the deterministic Join Markdown. Distinguish \`queued\`, \`running\`, \`awaiting_report\`, \`accepted\`, \`blocked\`, \`cancelled\`, and \`failed\`. If a task is blocked or failed, include the explicit reason and say whether Resume is available. Do not report a task as complete solely because a notification arrived.
`;

export function renderSkillMarkdown(
  kind: SkillTargetKind,
  command: string,
  args: string[],
): string {
  return `${FRONTMATTER}
<!-- octopunk-skill-version: ${OCTOPUNK_SKILL_VERSION} -->

# OctoPunk

## Overview

Use the configured \`octopunk\` MCP server as the task-control plane. Keep child agents in independent native sessions while OctoPunk owns task contracts, context snapshots, queueing, events, reports, review, and worktree lifecycle.

${connectionSection(kind, command, args)}

${BODY_TAIL}`;
}
