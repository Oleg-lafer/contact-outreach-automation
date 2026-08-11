import type { Page } from "playwright";
import type { AiUsageSummary } from "./outreach_types_(Support).js";

/*
 * ========================================================================
 * PROJECT-OWNED PAGE INTELLIGENCE CONTRACT
 * ========================================================================
 * Keeps workflow stages independent of a specific AI/browser SDK. The
 * Stagehand adapter is the only production implementation; tests can provide
 * small fakes without importing Stagehand or an AI provider.
 * ========================================================================
 */

export type PageIntelligenceStage =
  | "discovery"
  | "population"
  | "submission"
  | "confirmation";

export type PageIntelligenceVariableName =
  | "name"
  | "email"
  | "phone"
  | "message"
  | "company"
  | "role"
  | "website"
  | "country";

export type PageIntelligenceVariables = Partial<
  Record<PageIntelligenceVariableName, string>
>;

/**
 * A provider-neutral action returned by observation. `instruction` is the
 * model's description of this one action, not the original stage prompt.
 */
export interface PageIntelligenceAction {
  instruction: string;
  selector: string;
  method: string;
  arguments?: string[];
}

interface PageIntelligenceRequest {
  stage: PageIntelligenceStage;
  page: Page;
  instruction: string;
  timeoutMs?: number;
}

export interface PageIntelligenceObserveRequest
  extends PageIntelligenceRequest {
  variables?: PageIntelligenceVariables;
  selector?: string;
  ignoreSelectors?: string[];
}

export interface PageIntelligenceObserveResult {
  actions: PageIntelligenceAction[];
  model: string;
  durationMs: number;
}

export interface PageIntelligenceActRequest extends PageIntelligenceRequest {
  action: PageIntelligenceAction;
  variables?: PageIntelligenceVariables;
}

export interface PageIntelligenceActResult {
  success: boolean;
  message: string;
  actionDescription: string;
  actions: PageIntelligenceAction[];
  model: string;
  durationMs: number;
}

/**
 * Structural subset shared by supported validation schemas (including Zod).
 * Keeping this provider-neutral prevents Stagehand types from escaping the
 * runtime adapter while retaining a strongly typed extraction result.
 */
export interface PageIntelligenceSchema<T> {
  parse(value: unknown): T;
}

export interface PageIntelligenceExtractRequest<T>
  extends PageIntelligenceRequest {
  schema: PageIntelligenceSchema<T>;
  selector?: string;
  ignoreSelectors?: string[];
}

export interface PageIntelligenceExtractResult<T> {
  data: T;
  model: string;
  durationMs: number;
}

export interface PageIntelligence {
  readonly model: string;

  /** Optional because deterministic and test implementations do not use an LLM. */
  getUsageSummary?(): AiUsageSummary;

  observe(
    request: PageIntelligenceObserveRequest,
  ): Promise<PageIntelligenceObserveResult>;

  act(request: PageIntelligenceActRequest): Promise<PageIntelligenceActResult>;

  extract<T>(
    request: PageIntelligenceExtractRequest<T>,
  ): Promise<PageIntelligenceExtractResult<T>>;
}
