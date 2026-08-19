// Port of OctoPunk/OctoPunk/Application/Ports/AgentTeamServicePort.swift.

import type {
  ChildTaskDTO,
  DelegateTasksResultDTO,
  JoinTasksDTO,
  TaskExecutionLogSliceDTO,
  TaskReportDTO,
  TeamReviewContextDTO,
  TeamStatusDTO,
} from "../../shared/dtos";
import type {
  DelegateTaskInput,
  DelegateTasksInput,
  JoinTasksInput,
  ReviewDecisionInput,
  StartTeamInput,
} from "../domain/repositoryPort";
import type { ReviewCenterService } from "../application/reviewCenterService";
import type { QualityGateService } from "../application/qualityGateService";

/** Read-only live context supply for sub-agents (spec 001 FR-005…FR-008). */
export interface ReadOnlyContextPort {
  fetchTeamContext(runID: string, requesterTaskID: string, requestID: string): Promise<import("../../shared/dtos").ContextFetchDigestDTO>;
  fetchTaskReport(
    runID: string,
    requesterTaskID: string,
    targetTaskID: string,
    requestID: string,
  ): Promise<import("../../shared/dtos").TaskReportPayloadDTO>;
}

export interface AgentTeamServicePortLike {
  startTeam(input: StartTeamInput): Promise<TeamStatusDTO>;
  /** The session's active run, if any — used to default `run_id` in tool calls. */
  activeRunIDForSession(sessionID: string): Promise<string | null>;
  /** Session teardown: fails the session's still-active runs and stops their children. */
  failActiveRunsForSession(input: { sessionID: string; reason: string }): Promise<void>;
  delegateTask(input: DelegateTaskInput): Promise<ChildTaskDTO>;
  delegateTasks(input: DelegateTasksInput): Promise<DelegateTasksResultDTO>;
  joinTasks(input: JoinTasksInput): Promise<JoinTasksDTO>;
  waitForReport(runID: string, taskID: string, timeoutSeconds: number): Promise<TaskReportDTO>;
  getTaskReviewContext(runID: string, taskID: string): Promise<TeamReviewContextDTO>;
  getTaskExecutionLog(
    runID: string,
    taskID: string,
    afterSequence: number | null,
  ): Promise<TaskExecutionLogSliceDTO>;
  requestRework(input: ReviewDecisionInput): Promise<ChildTaskDTO>;
  acceptTask(input: ReviewDecisionInput): Promise<ChildTaskDTO>;
  blockTask(input: ReviewDecisionInput): Promise<ChildTaskDTO>;
  resumeTask(input: { requestID: string; runID: string; taskID: string }): Promise<ChildTaskDTO>;
  getTeamStatus(runID: string): Promise<TeamStatusDTO>;
  getTeamReviewContext(runID: string): Promise<TeamReviewContextDTO>;
  completeTeam(input: {
    requestID: string;
    runID: string;
    finalVerdict: "PASS" | "REWORK" | "BLOCKED";
    summary: string;
  }): Promise<TeamStatusDTO>;
  cancelTask(input: { requestID: string; runID: string; taskID: string }): Promise<ChildTaskDTO>;
  cancelTeam(input: { requestID: string; runID: string }): Promise<TeamStatusDTO>;
  discardTask(input: { requestID: string; runID: string; taskID: string }): Promise<ChildTaskDTO>;
  discardTeam(input: { requestID: string; runID: string }): Promise<TeamStatusDTO>;
  archiveTeam(input: { requestID: string; runID: string }): Promise<void>;
  unarchiveTeam(input: { requestID: string; runID: string }): Promise<void>;
  /**
   * Review Center use cases (task diff, line-anchored comments, batch rework,
   * delivery summary) shared by GUI and MCP (constitution principle two).
   * Optional: appEnvironment wires the instance; until then the MCP Review
   * Center tools answer with a readable error instead of failing to build.
   */
  reviewCenter?: ReviewCenterService;
  /**
   * Quality Gate use cases (config save, evaluate, waive) shared by GUI and
   * MCP (constitution principle two). Optional like reviewCenter: until
   * appEnvironment wires the instance the gate tools answer with a readable
   * error instead of failing to build.
   */
  qualityGate?: QualityGateService;
}
