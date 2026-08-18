// Tests for the transient-failure retry policy: classification, backoff
// progression, and the settings clamps that bound the user-facing values.

import { describe, expect, it } from "vitest";
import { ChildAgentDiagnostics } from "../electron/application/ports";
import { retryBackoffMs } from "../electron/application/agentTeamService";
import {
  clampLaunchStaggerSeconds,
  clampTaskRetryLimit,
  DEFAULT_TASK_RETRY_LIMIT,
} from "../shared/ipc";

describe("failure classification", () => {
  it("classifies the GLM 529 overload error as rate_limited", () => {
    const glmError =
      "API Error: 529 [1305][该模型当前访问量过大，请您稍后再试][202608181040552d]. This is a server-side issue.";
    expect(ChildAgentDiagnostics.failureKind(glmError)).toBe("rate_limited");
  });

  it("classifies 429 and classic rate-limit phrasings", () => {
    expect(ChildAgentDiagnostics.failureKind("HTTP 429 Too Many Requests")).toBe("rate_limited");
    expect(ChildAgentDiagnostics.failureKind("rate limit exceeded")).toBe("rate_limited");
    expect(ChildAgentDiagnostics.failureKind("The service is currently overloaded")).toBe("rate_limited");
  });

  it("separates transient kinds from terminal kinds", () => {
    expect(ChildAgentDiagnostics.failureKind("request timed out after 60s")).toBe("timeout");
    expect(ChildAgentDiagnostics.failureKind("invalid response: json-rpc error")).toBe("protocol_error");
    expect(ChildAgentDiagnostics.failureKind("unauthorized: bad token")).toBe("authentication");
    expect(ChildAgentDiagnostics.failureKind("executable not found")).toBe("executable");
    expect(ChildAgentDiagnostics.failureKind("something odd happened")).toBe("unknown");
  });

  it("marks only provider/transport failures as retryable", () => {
    expect(ChildAgentDiagnostics.isRetryable("rate_limited")).toBe(true);
    expect(ChildAgentDiagnostics.isRetryable("timeout")).toBe(true);
    expect(ChildAgentDiagnostics.isRetryable("protocol_error")).toBe(true);
    expect(ChildAgentDiagnostics.isRetryable("authentication")).toBe(false);
    expect(ChildAgentDiagnostics.isRetryable("executable")).toBe(false);
    expect(ChildAgentDiagnostics.isRetryable("cancelled")).toBe(false);
    expect(ChildAgentDiagnostics.isRetryable("unknown")).toBe(false);
  });
});

describe("retry backoff", () => {
  it("grows exponentially and caps at one minute", () => {
    expect(retryBackoffMs(0)).toBe(5_000);
    expect(retryBackoffMs(1)).toBe(15_000);
    expect(retryBackoffMs(2)).toBe(45_000);
    expect(retryBackoffMs(3)).toBe(60_000);
    expect(retryBackoffMs(10)).toBe(60_000);
  });

  it("treats negative indices as the first retry", () => {
    expect(retryBackoffMs(-1)).toBe(5_000);
  });
});

describe("execution policy clamps", () => {
  it("clamps the retry limit to 0–5 with a default fallback", () => {
    expect(clampTaskRetryLimit(2)).toBe(2);
    expect(clampTaskRetryLimit(-3)).toBe(0);
    expect(clampTaskRetryLimit(99)).toBe(5);
    expect(clampTaskRetryLimit("3")).toBe(3);
    expect(clampTaskRetryLimit(undefined)).toBe(DEFAULT_TASK_RETRY_LIMIT);
    expect(clampTaskRetryLimit("garbage")).toBe(DEFAULT_TASK_RETRY_LIMIT);
  });

  it("clamps the launch stagger to 0–30 seconds", () => {
    expect(clampLaunchStaggerSeconds(3)).toBe(3);
    expect(clampLaunchStaggerSeconds(-1)).toBe(0);
    expect(clampLaunchStaggerSeconds(120)).toBe(30);
    expect(clampLaunchStaggerSeconds("0")).toBe(0);
    expect(clampLaunchStaggerSeconds(null)).toBe(3);
  });
});
