// Port of OctoPunk/OctoPunk/Application/Services/ContextFetchService.swift.

import type { ContextFetchDigest } from "../domain/models";
import type { TeamRunRepository } from "../domain/repositoryPort";

/**
 * Application facade over the repository's read-only context queries. The
 * repository performs rendering, redaction, size caps, idempotency and the
 * `context.fetched` audit append inside one write transaction (constitution
 * II/IV); this service keeps the restricted MCP session on an Application
 * port instead of the SQLite adapter (constitution I).
 */
export class ContextFetchService {
  private readonly repository: TeamRunRepository;

  constructor(repository: TeamRunRepository) {
    this.repository = repository;
  }

  async fetchTeamContext(runID: string, requesterTaskID: string, requestID: string): Promise<ContextFetchDigest> {
    return await this.repository.fetchTeamContext({ requestID, runID, requesterTaskID });
  }

  async fetchTaskReport(
    runID: string,
    requesterTaskID: string,
    targetTaskID: string,
    requestID: string,
  ): Promise<{ taskID: string; report: string; truncated: boolean }> {
    return await this.repository.fetchTaskReport({ requestID, runID, requesterTaskID, targetTaskID });
  }
}
