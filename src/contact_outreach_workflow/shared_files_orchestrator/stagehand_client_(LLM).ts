import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import type {
  Action as StagehandAction,
  AISdkClient as StagehandAISdkClient,
  Stagehand,
  StagehandZodSchema,
} from "@browserbasehq/stagehand";
import { createOpenAI } from "@ai-sdk/openai";
import type { Page } from "playwright";
import {
  generateObject,
  generateText,
  type CoreAssistantMessage,
  type CoreSystemMessage,
  type CoreUserMessage,
  type ImagePart,
  type ModelMessage,
  type TextPart,
  type Tool,
} from "ai";
import {
  AI_ACTION_TIMEOUT_MS,
  AI_OBSERVE_TIMEOUT_MS,
  DEFAULT_OPENROUTER_API_KEY_FILE,
  OPENROUTER_API_KEY_FILE_ENVIRONMENT_VARIABLE,
  OPENROUTER_MODEL_ENVIRONMENT_VARIABLE,
} from "./outreach_constants_(Support).js";
import type {
  AiUsageSummary,
} from "./outreach_types_(Support).js";
import type {
  PageIntelligence,
  PageIntelligenceAction,
  PageIntelligenceActRequest,
  PageIntelligenceActResult,
  PageIntelligenceExtractRequest,
  PageIntelligenceExtractResult,
  PageIntelligenceObserveRequest,
  PageIntelligenceObserveResult,
} from "./page_intelligence_(Integration).js";

/*
 * ========================================================================
 * STAGEHAND / OPENROUTER RUNTIME BOUNDARY
 * ========================================================================
 * This is deliberately the only workflow module that imports Stagehand or an
 * AI provider. It loads secrets, owns the Stagehand instance, and adapts the
 * SDK into the project-owned PageIntelligence contract.
 * ========================================================================
 */

export interface StagehandConfiguration {
  apiKey: string;
  apiKeyFile: string;
  model: string;
}

export interface StagehandRuntimeOptions {
  cdpUrl: string;
  configuration?: StagehandConfiguration;
  environment?: NodeJS.ProcessEnv;
}

export interface StagehandRuntime {
  connectUrl: string;
  pageIntelligence: PageIntelligence;
  close: () => Promise<void>;
}

type StagehandCreateChatCompletionInput = Parameters<
  StagehandAISdkClient["createChatCompletion"]
>[0];
type StagehandLanguageModel = ConstructorParameters<
  typeof StagehandAISdkClient
>[0]["model"];

interface AiSdkUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  totalTokens?: number | undefined;
}

interface StagehandOperationContext {
  signal: AbortSignal;
}

interface BoundedStagehandAISdkClient extends StagehandAISdkClient {
  runBounded<T>(
    timeoutMs: number,
    operation: () => Promise<T>,
  ): Promise<T>;
}

const stagehand_operation_context =
  new AsyncLocalStorage<StagehandOperationContext>();

export async function load_stagehand_configuration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<StagehandConfiguration> {
  const model = environment[OPENROUTER_MODEL_ENVIRONMENT_VARIABLE]?.trim();
  if (!model) {
    throw configuration_error(
      `${OPENROUTER_MODEL_ENVIRONMENT_VARIABLE} is required when ` +
        "CONTACT_FORM_ENGINE=stagehand.",
    );
  }

  if (!is_valid_model(model)) {
    throw configuration_error(
      `${OPENROUTER_MODEL_ENVIRONMENT_VARIABLE} must be a valid model identifier.`,
    );
  }

  const configured_key_file =
    environment[OPENROUTER_API_KEY_FILE_ENVIRONMENT_VARIABLE]?.trim();
  const api_key_file = configured_key_file || DEFAULT_OPENROUTER_API_KEY_FILE;

  let raw_key: string;
  try {
    raw_key = await readFile(api_key_file, "utf8");
  } catch {
    throw configuration_error(
      `Could not read the OpenRouter API key file at "${api_key_file}".`,
    );
  }

  const api_key = extract_api_key(raw_key);
  if (!is_valid_raw_api_key(api_key)) {
    throw configuration_error(
      "The API key source must contain either one raw token or a Java " +
        'String declaration named "apiKey".',
    );
  }

  return {
    apiKey: api_key,
    apiKeyFile: api_key_file,
    model,
  };
}

export async function create_stagehand_runtime(
  options: StagehandRuntimeOptions,
): Promise<StagehandRuntime> {
  // Configuration is intentionally resolved before Stagehand is constructed,
  // because constructing/initializing it may launch a local browser.
  const configuration =
    options.configuration ??
    (await load_stagehand_configuration(options.environment));
  assert_stagehand_flow_logging_disabled(
    options.environment ?? process.env,
    process.env,
  );
  // Stagehand is intentionally loaded only after the ambient log sinks are
  // rejected. Version 3.6 captures these variables at module evaluation time.
  const { AISdkClient, Stagehand } = await import(
    "@browserbasehq/stagehand"
  );
  const openai = createOpenAI({
    apiKey: configuration.apiKey,
  });
  const language_model = openai.chat(configuration.model) as unknown as StagehandLanguageModel;
  const usage_tracker = new OpenRouterUsageTracker(
    configuration.apiKey,
    configuration.model,
    false,
  );
  const llm_client = create_bounded_ai_sdk_client(
    AISdkClient,
    // The pinned OpenRouter provider and Stagehand versions use the same AI
    // SDK v2 protocol at runtime, but their transitive provider patch versions
    // expose incompatible exact-optional metadata types to TypeScript.
    language_model,
    usage_tracker,
  );
  const stagehand = new Stagehand({
    env: "LOCAL",
    llmClient: llm_client,
    localBrowserLaunchOptions: {
      cdpUrl: options.cdpUrl,
    },
    verbose: 0,
    selfHeal: false,
    waitForCaptchaSolves: false,
    actTimeoutMs: AI_ACTION_TIMEOUT_MS,
    logInferenceToFile: false,
    disablePino: true,
    disableAPI: true,
    serverCache: false,
  });

  try {
    await stagehand.init();
  } catch (error) {
    await stagehand.close({ force: true }).catch(() => undefined);
    throw new Error(
      `Could not initialize the local Stagehand browser: ${safe_error_message(
        error,
        [configuration.apiKey],
      )}`,
    );
  }

  return {
    connectUrl: stagehand.connectURL(),
    pageIntelligence: new StagehandPageIntelligence(
      stagehand,
      configuration.model,
      llm_client,
      usage_tracker,
    ),
    close: async () => {
      await stagehand.close({ force: true });
    },
  };
}

function create_bounded_ai_sdk_client(
  AISdkClient: typeof StagehandAISdkClient,
  model: StagehandLanguageModel,
  usage_tracker: OpenRouterUsageTracker,
): BoundedStagehandAISdkClient {
  class WorkflowAISdkClient extends AISdkClient {
    private readonly workflow_model: StagehandLanguageModel;

    constructor() {
      super({ model });
      this.workflow_model = model;
    }

    async runBounded<T>(
      timeout_ms: number,
      operation: () => Promise<T>,
    ): Promise<T> {
      const controller = new AbortController();
      let timeout_handle: NodeJS.Timeout | undefined;
      const operation_promise = stagehand_operation_context.run(
        { signal: controller.signal },
        operation,
      );
      const timeout_promise = new Promise<never>((_resolve, reject) => {
        timeout_handle = setTimeout(() => {
          const timeout_error = new Error(
            `Stagehand AI operation exceeded ${timeout_ms} ms`,
          );
          controller.abort(timeout_error);
          reject(timeout_error);
        }, timeout_ms);
      });

      try {
        return await Promise.race([operation_promise, timeout_promise]);
      } finally {
        if (timeout_handle) {
          clearTimeout(timeout_handle);
        }
        // If the outer race times out while Stagehand is still unwinding, keep
        // its rejection handled. AsyncLocalStorage retains the aborted signal
        // for any delayed provider call spawned by that operation.
        void operation_promise.catch(() => undefined);
      }
    }

    override async createChatCompletion<T = unknown>({
      options,
    }: StagehandCreateChatCompletionInput): Promise<T> {
      const formatted_messages: ModelMessage[] = options.messages.map(
        (message) => {
          if (Array.isArray(message.content)) {
            if (message.role === "system") {
              const system_message: CoreSystemMessage = {
                role: "system",
                content: message.content
                  .map((content) => ("text" in content ? content.text : ""))
                  .join("\n"),
              };
              return system_message;
            }

            const content_parts = message.content.map((content) => {
              if ("image_url" in content && content.image_url) {
                const image_content: ImagePart = {
                  type: "image",
                  image: content.image_url.url,
                };
                return image_content;
              }
              const text_content: TextPart = {
                type: "text",
                text: content.text ?? "",
              };
              return text_content;
            });

            if (message.role === "user") {
              const user_message: CoreUserMessage = {
                role: "user",
                content: content_parts,
              };
              return user_message;
            }

            const text_only_parts = content_parts.map((part) => ({
              type: "text" as const,
              text: part.type === "image" ? "[Image]" : part.text,
            }));
            const assistant_message: CoreAssistantMessage = {
              role: "assistant",
              content: text_only_parts,
            };
            return assistant_message;
          }

          return {
            role: message.role,
            content: message.content,
          };
        },
      );
      const signal = stagehand_operation_context.getStore()?.signal;

      usage_tracker.begin_request();
      try {
      if (options.response_model) {
        const response = await generateObject({
          model: this.workflow_model,
          messages: formatted_messages,
          schema: options.response_model.schema,
          maxRetries: 0,
          ...(signal ? { abortSignal: signal } : {}),
        });
        await usage_tracker.complete_request(response.usage, response.response.id);

        return {
          data: response.object,
          usage: ai_sdk_usage(response.usage),
        } as T;
      }

      const tools: Record<string, Tool> = {};
      for (const raw_tool of options.tools ?? []) {
        tools[raw_tool.name] = {
          description: raw_tool.description,
          inputSchema: raw_tool.parameters,
        } as Tool;
      }

      const response = await generateText({
        model: this.workflow_model,
        messages: formatted_messages,
        tools,
        maxRetries: 0,
        ...(signal ? { abortSignal: signal } : {}),
      });
      await usage_tracker.complete_request(response.usage, response.response.id);

      return {
        data: response.text,
        usage: ai_sdk_usage(response.usage),
      } as T;
      } catch (error) {
        usage_tracker.fail_request();
        throw error;
      }
    }
  }

  return new WorkflowAISdkClient();
}

function ai_sdk_usage(usage: AiSdkUsage): {
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  total_tokens: number;
} {
  return {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    reasoning_tokens: usage.reasoningTokens ?? 0,
    cached_input_tokens: usage.cachedInputTokens ?? 0,
    total_tokens: usage.totalTokens ?? 0,
  };
}

/** Records provider-reported usage without retaining prompts, responses, or keys. */
export class OpenRouterUsageTracker {
  private readonly usage: AiUsageSummary;

  constructor(
    private readonly api_key: string,
    private readonly model: string,
    private readonly cost_lookup_enabled = true,
  ) {
    this.usage = {
      model,
      requestCount: 0,
      completedRequestCount: 0,
      failedRequestCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 0,
      costUnavailableRequestCount: 0,
    };
  }

  begin_request(): void {
    this.usage.requestCount += 1;
  }

  async complete_request(
    usage: AiSdkUsage,
    generation_id: string,
  ): Promise<void> {
    this.usage.completedRequestCount += 1;
    this.usage.promptTokens += usage.inputTokens ?? 0;
    this.usage.completionTokens += usage.outputTokens ?? 0;
    this.usage.reasoningTokens += usage.reasoningTokens ?? 0;
    this.usage.cachedInputTokens += usage.cachedInputTokens ?? 0;
    this.usage.totalTokens += usage.totalTokens ?? 0;

    const cost = await this.lookup_cost(generation_id);
    if (cost === undefined) {
      this.usage.costUnavailableRequestCount += 1;
    } else {
      this.usage.costUsd = (this.usage.costUsd ?? 0) + cost;
    }
  }

  fail_request(): void {
    this.usage.failedRequestCount += 1;
  }

  snapshot(): AiUsageSummary {
    return { ...this.usage };
  }

  private async lookup_cost(generation_id: string): Promise<number | undefined> {
    if (!this.cost_lookup_enabled || !generation_id) {
      return undefined;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(
        `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generation_id)}`,
        {
          headers: { Authorization: `Bearer ${this.api_key}` },
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        return undefined;
      }
      const payload: unknown = await response.json();
      const raw_cost = (payload as { data?: { total_cost?: unknown } }).data
        ?.total_cost;
      const cost = typeof raw_cost === "number" ? raw_cost : Number(raw_cost);
      return Number.isFinite(cost) && cost >= 0 ? cost : undefined;
    } catch {
      // Accounting must never turn a completed automation action into a fail.
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class StagehandPageIntelligence implements PageIntelligence {
  constructor(
    private readonly stagehand: Stagehand,
    readonly model: string,
    private readonly llm_client: BoundedStagehandAISdkClient,
    private readonly usage_tracker: OpenRouterUsageTracker,
  ) {}

  getUsageSummary(): AiUsageSummary {
    return this.usage_tracker.snapshot();
  }

  async observe(
    request: PageIntelligenceObserveRequest,
  ): Promise<PageIntelligenceObserveResult> {
    const started_at = Date.now();
    try {
      const timeout_ms = request.timeoutMs ?? AI_OBSERVE_TIMEOUT_MS;
      const actions = await with_ignored_page_selectors(
        request.page,
        request.ignoreSelectors,
        () =>
          this.llm_client.runBounded(timeout_ms, () =>
            this.stagehand.observe(request.instruction, {
              page: request.page,
              timeout: timeout_ms,
              serverCache: false,
              ...(request.selector ? { selector: request.selector } : {}),
              ...(request.variables ? { variables: request.variables } : {}),
            }),
          ),
      );

      return {
        actions: actions.map(to_page_intelligence_action),
        model: this.model,
        durationMs: Date.now() - started_at,
      };
    } catch (error) {
      throw this.operation_error("observation", request, error);
    }
  }

  async act(
    request: PageIntelligenceActRequest,
  ): Promise<PageIntelligenceActResult> {
    const started_at = Date.now();
    try {
      const timeout_ms = request.timeoutMs ?? AI_ACTION_TIMEOUT_MS;
      const result = await this.llm_client.runBounded(timeout_ms, () =>
        this.stagehand.act(to_stagehand_action(request.action), {
          page: request.page,
          timeout: timeout_ms,
          serverCache: false,
          ...(request.variables ? { variables: request.variables } : {}),
        }),
      );

      return {
        success: result.success,
        message: result.message,
        actionDescription: result.actionDescription,
        actions: result.actions.map(to_page_intelligence_action),
        model: this.model,
        durationMs: Date.now() - started_at,
      };
    } catch (error) {
      throw this.operation_error("action", request, error);
    }
  }

  async extract<T>(
    request: PageIntelligenceExtractRequest<T>,
  ): Promise<PageIntelligenceExtractResult<T>> {
    const started_at = Date.now();
    try {
      const timeout_ms = request.timeoutMs ?? AI_OBSERVE_TIMEOUT_MS;
      const extracted = await with_ignored_page_selectors(
        request.page,
        request.ignoreSelectors,
        () =>
          this.llm_client.runBounded(timeout_ms, () =>
            this.stagehand.extract(
              request.instruction,
              request.schema as StagehandZodSchema,
              {
                page: request.page,
                timeout: timeout_ms,
                serverCache: false,
                ...(request.selector ? { selector: request.selector } : {}),
              },
            ),
          ),
      );

      return {
        data: request.schema.parse(extracted),
        model: this.model,
        durationMs: Date.now() - started_at,
      };
    } catch (error) {
      throw this.operation_error("extraction", request, error);
    }
  }

  private operation_error(
    operation: string,
    request:
      | PageIntelligenceObserveRequest
      | PageIntelligenceActRequest
      | PageIntelligenceExtractRequest<unknown>,
    error: unknown,
  ): Error {
    return new Error(
      `Stagehand ${request.stage} ${operation} failed ` +
        `(${classify_stagehand_operation_error(error)}).`,
    );
  }
}

async function with_ignored_page_selectors<T>(
  page: Page,
  selectors: string[] | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!selectors || selectors.length === 0) {
    return operation();
  }

  const marker = `contact-workflow-ai-hidden-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      await frame
        .locator(selector)
        .evaluateAll((elements, marker_value) => {
          for (const element of elements as HTMLElement[]) {
            if (element.dataset.contactWorkflowAiHidden) {
              continue;
            }
            element.dataset.contactWorkflowAiHidden = String(marker_value);
            element.dataset.contactWorkflowAiOriginalStyle =
              element.getAttribute("style") ?? "__missing__";
            element.style.setProperty("display", "none", "important");
          }
        }, marker)
        .catch(() => undefined);
    }
  }

  try {
    return await operation();
  } finally {
    for (const frame of page.frames()) {
      await frame
        .locator(`[data-contact-workflow-ai-hidden="${marker}"]`)
        .evaluateAll((elements) => {
          for (const element of elements as HTMLElement[]) {
            const original = element.dataset.contactWorkflowAiOriginalStyle;
            if (original === "__missing__") {
              element.removeAttribute("style");
            } else if (original !== undefined) {
              element.setAttribute("style", original);
            }
            delete element.dataset.contactWorkflowAiHidden;
            delete element.dataset.contactWorkflowAiOriginalStyle;
          }
        })
        .catch(() => undefined);
    }
  }
}

function to_page_intelligence_action(
  action: StagehandAction,
): PageIntelligenceAction {
  return {
    instruction: action.description,
    selector: action.selector,
    method: action.method ?? "",
    ...(action.arguments ? { arguments: [...action.arguments] } : {}),
  };
}

function to_stagehand_action(
  action: PageIntelligenceAction,
): StagehandAction {
  return {
    description: action.instruction,
    selector: action.selector,
    method: action.method,
    ...(action.arguments ? { arguments: [...action.arguments] } : {}),
  };
}

function is_valid_model(model: string): boolean {
  return model.length > 0 && !/\s/.test(model);
}

function extract_api_key(source: string): string {
  const trimmed = source.trim();
  if (is_valid_raw_api_key(trimmed)) return trimmed;
  const java_declaration = source.match(
    /\bapiKey\s*=\s*"([^"\r\n]+)"\s*;/,
  );
  return java_declaration?.[1]?.trim() ?? "";
}

function is_valid_raw_api_key(api_key: string): boolean {
  return api_key.length > 0 && !/\s/.test(api_key) && !api_key.includes("=");
}

function assert_stagehand_flow_logging_disabled(
  configured_environment: NodeJS.ProcessEnv,
  process_environment: NodeJS.ProcessEnv,
): void {
  const environments = [configured_environment, process_environment];
  const file_logging_enabled = environments.some(
    (environment) => Boolean(environment.BROWSERBASE_CONFIG_DIR),
  );
  const stderr_logging_enabled = environments.some(
    (environment) => environment.BROWSERBASE_FLOW_LOGS === "1",
  );

  if (file_logging_enabled || stderr_logging_enabled) {
    throw configuration_error(
      "Stagehand flow logging must be disabled: unset " +
        "BROWSERBASE_CONFIG_DIR and BROWSERBASE_FLOW_LOGS before hybrid runs.",
    );
  }
}

function classify_stagehand_operation_error(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|exceeded|abort/i.test(message)) {
    return "timeout";
  }
  if (/\b(?:401|403)\b|unauthori[sz]ed|authentication|api[ -]?key/i.test(message)) {
    return "authentication error";
  }
  if (/\b429\b|rate[ -]?limit|too many requests/i.test(message)) {
    return "rate limit";
  }
  if (/schema|structured|parse|invalid json|json output/i.test(message)) {
    return "invalid structured output";
  }
  if (/network|fetch|econn|enotfound|dns|socket|connection/i.test(message)) {
    return "network error";
  }
  return "provider or model error";
}

function configuration_error(message: string): Error {
  return new Error(`Stagehand configuration error: ${message}`);
}

function safe_error_message(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) {
      message = message.replaceAll(secret, "[redacted]");
    }
  }

  message = message
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]");

  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.slice(0, 500) || "Unknown Stagehand error.";
}
