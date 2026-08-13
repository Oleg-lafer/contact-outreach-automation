import { z } from "zod";
import { AI_OBSERVE_TIMEOUT_MS } from "../../../../shared_files_orchestrator/outreach_constants_(Support).js";
import { describe_error } from "../../../../shared_files_orchestrator/outreach_errors_(Support).js";
import { CAPTCHA_SELECTOR } from "../../shared_files_forms/captcha_detection_(Deterministic).js";
import { create_ai_operation_evidence } from "../../../../shared_files_orchestrator/ai_observability_(Support).js";
import type { PageIntelligence } from "../../../../shared_files_orchestrator/page_intelligence_(Integration).js";
import { with_masked_page_values } from "../../../../shared_files_orchestrator/page_value_redaction_(Integration).js";
import type {
  AiActionEvidence,
  SubmissionConfirmationEvidence,
} from "../../shared_files_forms/forms_types_(Support).js";
import type { MessageCandidateDebugInfo } from "./C2_submission_types_(Support).js";

const CONFIRMATION_CLASSIFICATION_INSTRUCTION =
  "Classify whether a newly visible status, alert, notification, or message explicitly confirms that the contact form was submitted, sent, or received. The visible interface may be in English, Hebrew, or a mixture of both languages. Generic thanks, calls to action, validation messages, pending states, and unrelated page text are not success. Return the exact visible evidence text verbatim and use high confidence only for unambiguous confirmation.";

const confirmation_schema = z.object({
  isExplicitSuccess: z.boolean(),
  confidence: z.enum(["low", "medium", "high"]),
  evidenceText: z.string(),
});

type ConfirmationClassification = z.infer<typeof confirmation_schema>;

export interface StagehandConfirmationFallbackResult {
  evidence: SubmissionConfirmationEvidence;
  reason: string;
  evidenceText?: string;
  aiActions: AiActionEvidence[];
}

interface StagehandConfirmationFallbackInput {
  pageIntelligence: PageIntelligence;
  page: Parameters<PageIntelligence["extract"]>[0]["page"];
  messagesBeforeSubmission: MessageCandidateDebugInfo[];
  messagesAfterSubmission: MessageCandidateDebugInfo[];
  redactionValues: string[];
}

/*
 * ========================================================================
 * STAGEHAND CONFIRMATION FALLBACK
 * ========================================================================
 * Runs one structured classification only after deterministic evidence is
 * absent. A high-confidence result is accepted only when its evidence text
 * exactly matches a newly visible message after whitespace normalization.
 * ========================================================================
 */
export async function classify_stagehand_submission_confirmation({
  pageIntelligence,
  page,
  messagesBeforeSubmission,
  messagesAfterSubmission,
  redactionValues,
}: StagehandConfirmationFallbackInput): Promise<StagehandConfirmationFallbackResult> {
  const new_messages = newly_visible_messages(
    messagesBeforeSubmission,
    messagesAfterSubmission,
  );
  if (new_messages.length === 0) {
    return {
      evidence: "none",
      reason: "no newly visible message was available for AI confirmation",
      aiActions: [],
    };
  }

  const safe_new_messages = new_messages.map((message) => ({
    ...message,
    text: redact_visible_text(message.text, redactionValues),
  }));
  let message_selector = "";
  let extraction;
  const extraction_started_at = Date.now();
  try {
    message_selector = await create_confirmation_text_scope(
      page,
      safe_new_messages.map((message) => message.text),
    );
    extraction = await with_masked_page_values(page, redactionValues, () =>
      pageIntelligence.extract<ConfirmationClassification>({
        stage: "confirmation",
        page,
        instruction: CONFIRMATION_CLASSIFICATION_INSTRUCTION,
        schema: confirmation_schema,
        selector: message_selector,
        ignoreSelectors: [CAPTCHA_SELECTOR],
        timeoutMs: AI_OBSERVE_TIMEOUT_MS,
      }),
    );
  } catch (error) {
    return {
      evidence: "none",
      reason: `Stagehand confirmation classification failed: ${describe_error(error)}`,
      aiActions: [
        create_ai_operation_evidence({
          stage: "confirmation",
          placeholderInstruction: CONFIRMATION_CLASSIFICATION_INSTRUCTION,
          method: "extract",
          model: pageIntelligence.model,
          durationMs: Date.now() - extraction_started_at,
          acceptanceReason: "Stagehand confirmation extraction failed",
          result: "failed",
        }),
      ],
    };
  } finally {
    if (message_selector) {
      await remove_confirmation_text_scope(page, message_selector);
    }
  }

  const classification = extraction.data;
  const normalized_evidence = normalize_visible_text(
    classification.evidenceText,
  );
  const matched_message = safe_new_messages.find(
    (message) => normalize_visible_text(message.text) === normalized_evidence,
  );
  const explicit_success_language = has_explicit_submission_success_language(
    normalized_evidence,
  );
  const accepted =
    classification.isExplicitSuccess &&
    classification.confidence === "high" &&
    normalized_evidence.length > 0 &&
    Boolean(matched_message) &&
    explicit_success_language;
  const acceptance_reason = accepted
    ? "high-confidence explicit success text exactly matched a newly visible message"
    : !classification.isExplicitSuccess
      ? "the classifier did not identify explicit submission success"
      : classification.confidence !== "high"
        ? "the classifier confidence was not high"
        : !explicit_success_language
          ? "the evidence text lacked explicit submission-success language"
        : "the evidence text did not exactly match a newly visible message";
  const ai_action: AiActionEvidence = {
    stage: "confirmation",
    placeholderInstruction: CONFIRMATION_CLASSIFICATION_INSTRUCTION,
    selector: message_selector,
    method: "extract",
    acceptance: accepted ? "accepted" : "rejected",
    acceptanceReason: acceptance_reason,
    result: accepted ? "succeeded" : "observed",
    ...(accepted
      ? { resultMessage: "explicit visible confirmation verified" }
      : {}),
    model: extraction.model,
    durationMs: extraction.durationMs,
  };

  return accepted && matched_message
    ? {
        evidence: "aiVisibleText",
        reason: acceptance_reason,
        evidenceText: matched_message.text,
        aiActions: [ai_action],
      }
    : {
        evidence: "none",
        reason: acceptance_reason,
        aiActions: [ai_action],
      };
}

function newly_visible_messages(
  before: MessageCandidateDebugInfo[],
  after: MessageCandidateDebugInfo[],
): MessageCandidateDebugInfo[] {
  const existing_text = new Set(
    before.map((message) => normalize_visible_text(message.text)),
  );
  return after.filter(
    (message) => !existing_text.has(normalize_visible_text(message.text)),
  );
}

function normalize_visible_text(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function has_explicit_submission_success_language(value: string): boolean {
  if (
    /\b(?:not|never|failed|failure|unable|could(?:n't| not)|was(?:n't| not)|has(?:n't| not)|did(?:n't| not)|error|unsuccessful|try again)\b/i.test(
      value,
    )
  ) {
    return false;
  }

  const subject =
    "(?:message|request|inquir(?:y|ies)|enquir(?:y|ies)|form|submission|correspondence)";
  const completion =
    "(?:sent|submitted|received|delivered|entered|queued|logged|recorded|accepted|completed?)";
  return (
    new RegExp(`\\b${subject}\\b.{0,100}\\b${completion}\\b`, "i").test(
      value,
    ) ||
    new RegExp(`\\b${completion}\\b.{0,100}\\b${subject}\\b`, "i").test(
      value,
    ) ||
    /\bwe(?:'ll| will) (?:be )?in touch\b/i.test(value)
  );
}

function redact_visible_text(value: string, redaction_values: string[]): string {
  return redaction_values.reduce(
    (redacted, sensitive_value) =>
      sensitive_value
        ? redacted.replaceAll(sensitive_value, "[redacted contact value]")
        : redacted,
    value,
  );
}

async function create_confirmation_text_scope(
  page: StagehandConfirmationFallbackInput["page"],
  messages: string[],
): Promise<string> {
  const scope_id = `contact-workflow-ai-confirmation-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  await page.evaluate(
    ({ id, text }) => {
      const scope = document.createElement("div");
      scope.id = id;
      scope.setAttribute("role", "status");
      scope.style.cssText =
        "position:fixed;left:0;bottom:0;width:1px;height:1px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1;white-space:pre-wrap";
      scope.textContent = text;
      document.body.append(scope);
    },
    { id: scope_id, text: messages.join("\n\n") },
  );
  return `#${scope_id}`;
}

async function remove_confirmation_text_scope(
  page: StagehandConfirmationFallbackInput["page"],
  selector: string,
): Promise<void> {
  await page
    .locator(selector)
    .evaluateAll((elements) => elements.forEach((element) => element.remove()))
    .catch(() => undefined);
}
