import type { Locator, Page } from "playwright";

export type DeepDebugStage =
  | "orchestrator"
  | "browser"
  | "population"
  | "handoff"
  | "submission"
  | "confirmation"
  | "runtime"
  | "ai";

export type DeepDebugEventOutcome =
  | "started"
  | "observed"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped";

export interface DeepDebugEventInput {
  stage: DeepDebugStage;
  substage: string;
  operation: string;
  outcome: DeepDebugEventOutcome;
  reason?: string;
  url?: string;
  frameUrl?: string;
  correlationId?: string;
  durationMs?: number;
  data?: unknown;
}

export interface DeepDebugArtifactSummary {
  runId: string;
  artifactDirectory: string;
  manifestPath: string;
  timelinePath: string;
  summaryPath: string;
  eventCount: number;
  artifactErrorCount: number;
  truncatedEventCount: number;
}

export interface DeepDebugFinalizeInput {
  outcome?: unknown;
  aiUsage?: unknown;
  failure?: string;
}

export interface DeepDebugContext {
  readonly runId: string;
  readonly artifactDirectory: string;
  readonly redactionValues: readonly string[];
  record(event: DeepDebugEventInput): void;
  writeJson(relativePath: string, value: unknown): Promise<string | undefined>;
  captureFormSnapshot(options: {
    stage: "population" | "handoff" | "submission" | "confirmation";
    label: string;
    form: Locator;
    expectedValues?: readonly string[];
    extra?: unknown;
  }): Promise<unknown | undefined>;
  captureScreenshot(
    page: Page,
    stage: "population" | "handoff" | "submission" | "confirmation",
    label: string,
  ): Promise<string | undefined>;
  attachPage(page: Page): Promise<void>;
  recordAiOperations(
    stage: "population" | "submission" | "confirmation",
    trigger: string,
    operations: readonly unknown[],
  ): void;
  finalize(input: DeepDebugFinalizeInput): Promise<DeepDebugArtifactSummary>;
  summary(): DeepDebugArtifactSummary;
}

export interface DeepDebugCreateOptions {
  outputPath: string;
  targetUrl: string;
  engine: "playwright" | "stagehand";
  redactionValues: readonly string[];
  environment?: NodeJS.ProcessEnv;
}
