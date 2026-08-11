import { z } from "zod";
import { AI_OBSERVE_TIMEOUT_MS } from "../../../../shared_files_orchestrator/outreach_constants_(Support).js";
import { describe_error } from "../../../../shared_files_orchestrator/outreach_errors_(Support).js";
import type {
  AiActionEvidence,
  ContactFormCandidate,
} from "../../shared_files_forms/forms_types_(Support).js";
import { CAPTCHA_SELECTOR } from "../../shared_files_forms/captcha_detection_(Deterministic).js";
import type { ContactFormAssessment } from "../../shared_files_forms/contact_form_intent_(Deterministic).js";
import type { PageIntelligence } from "../../../../shared_files_orchestrator/page_intelligence_(Integration).js";
import { create_page_intelligence_scope } from "../../../../shared_files_orchestrator/page_value_redaction_(Integration).js";
import type { Frame, Locator, Page } from "playwright";

const BUSINESS_INQUIRY_CLASSIFICATION_INSTRUCTION = [
  "Classify the purpose of this one visible form.",
  "A business contact inquiry lets a prospective customer describe a project, service need, quote request, consultation, or other business request to the organization.",
  "Do not classify newsletter signup, search, login/account access, route/directions, job applications, or unrelated forms as business contact inquiries.",
  "Base the answer only on the scoped form's visible labels, controls, headings, and submit text.",
].join(" ");

const business_inquiry_schema = z.object({
  purpose: z.enum([
    "business_contact_inquiry",
    "newsletter_or_subscription",
    "search_or_login",
    "route_or_directions",
    "job_application",
    "other",
  ]),
  acceptsBusinessInquiry: z.boolean(),
});

type BusinessInquiryClassification = z.infer<typeof business_inquiry_schema>;

interface RejectedFormSemanticRecoveryInput {
  pageIntelligence: PageIntelligence;
  page: Page;
  frame: Frame;
  form: Locator;
  assessment: ContactFormAssessment;
  observedSelector: string;
}

export interface RejectedFormSemanticRecoveryResult {
  attempted: boolean;
  candidate?: ContactFormCandidate;
  reason: string;
  aiActions: AiActionEvidence[];
}

/*
 * One bounded semantic adjudication for a deterministic false negative.
 * The model sees only a form that already passed every positive structural
 * requirement. It cannot click, fill, submit, or weaken any browser safety
 * boundary; a positive classification only returns locator evidence to the
 * existing population and submission stages.
 */
export async function recover_structurally_strong_rejected_form(
  input: RejectedFormSemanticRecoveryInput,
): Promise<RejectedFormSemanticRecoveryResult> {
  if (!passes_semantic_recovery_structure(input.assessment)) {
    return {
      attempted: false,
      reason:
        "rejected form did not pass the semantic-recovery structural gate",
      aiActions: [],
    };
  }

  let scope;
  try {
    scope = await create_page_intelligence_scope(input.form);
  } catch (error) {
    return {
      attempted: false,
      reason: `could not create a safe rejected-form scope: ${describe_error(error)}`,
      aiActions: [],
    };
  }

  const extraction_started_at = Date.now();
  try {
    const extraction =
      await input.pageIntelligence.extract<BusinessInquiryClassification>({
        stage: "discovery",
        page: input.page,
        instruction: BUSINESS_INQUIRY_CLASSIFICATION_INSTRUCTION,
        schema: business_inquiry_schema,
        selector: scope.selector,
        ignoreSelectors: [CAPTCHA_SELECTOR],
        timeoutMs: AI_OBSERVE_TIMEOUT_MS,
      });
    const accepted =
      extraction.data.purpose === "business_contact_inquiry" &&
      extraction.data.acceptsBusinessInquiry;
    const reason = accepted
      ? "scoped semantic classification confirmed a structurally strong business contact inquiry"
      : "scoped semantic classification did not confirm a business contact inquiry";
    const evidence: AiActionEvidence = {
      stage: "discovery",
      placeholderInstruction: BUSINESS_INQUIRY_CLASSIFICATION_INSTRUCTION,
      selector: input.observedSelector,
      method: "extract",
      normalization: "scoped to a structurally strong rejected form",
      acceptance: accepted ? "accepted" : "rejected",
      acceptanceReason: reason,
      result: accepted ? "succeeded" : "observed",
      ...(accepted
        ? { resultMessage: "business contact inquiry purpose verified" }
        : {}),
      model: extraction.model,
      durationMs: extraction.durationMs,
    };

    return accepted
      ? {
          attempted: true,
          candidate: {
            form: input.form,
            frame: input.frame,
            score: input.assessment.score,
            source: "stagehand",
            structure: "nativeForm",
            classification: "complete",
            messageDisposition: "unresolved",
          },
          reason,
          aiActions: [evidence],
        }
      : { attempted: true, reason, aiActions: [evidence] };
  } catch (error) {
    const reason = `Stagehand rejected-form classification failed: ${describe_error(error)}`;
    return {
      attempted: true,
      reason,
      aiActions: [
        {
          stage: "discovery",
          placeholderInstruction: BUSINESS_INQUIRY_CLASSIFICATION_INSTRUCTION,
          selector: input.observedSelector,
          method: "extract",
          normalization: "scoped to a structurally strong rejected form",
          acceptance: "rejected",
          acceptanceReason: reason,
          result: "failed",
          model: input.pageIntelligence.model,
          durationMs: Date.now() - extraction_started_at,
        },
      ],
    };
  } finally {
    await scope.close();
  }
}

function passes_semantic_recovery_structure(
  assessment: ContactFormAssessment,
): boolean {
  const signals = assessment.signals;
  return (
    !assessment.accepted &&
    assessment.classification === "rejected" &&
    signals.visibleControlCount >= 3 &&
    signals.hasEmail &&
    signals.hasIdentity &&
    signals.hasBusinessOrProject &&
    signals.hasContactContext &&
    signals.hasMessage &&
    signals.hasSubmit
  );
}
