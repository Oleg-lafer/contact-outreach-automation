import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import type { SubmissionDebugSummary } from "../../shared_files_forms/forms_types_(Support).js";
import { with_masked_page_values } from "../../../../shared_files_orchestrator/page_value_redaction_(Integration).js";
import type {
  ButtonControlDebugInfo,
  FinalizeSubmissionDebugInput,
  MessageCandidateDebugInfo,
  SubmissionDebugContext,
  SubmissionDebugOptions,
} from "./C2_submission_types_(Support).js";
import {
  summarize_button_click,
  summarize_button_control,
} from "./C4_button_click_audit_(Support).js";

/*
 * TOP LEVEL WORKFLOW:
 *
 * create_submission_debug_context(options)
 *        |
 *        v
 * safe_page_screenshot(page, path)
 *        |
 *        v
 * collect_visible_message_candidates(page)
 *        |
 *        v
 * finalize_submission_debug(...)
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * SUBMISSION DEBUG CONTEXT CREATION - create_submission_debug_context(...)
 * ========================================================================
 * Input:  Optional submission debug artifact directory.
 * Output: Absolute and report-relative artifact paths.
 *
 * Responsibility: Derive all submission observability artifact paths from the
 * selected production report folder.
 * ========================================================================
 */
export function create_submission_debug_context(
  options: SubmissionDebugOptions,
): SubmissionDebugContext | undefined {
  if (!options.artifactDirectory) {
    return undefined;
  }

  const absolute_artifact_directory = resolve(options.artifactDirectory);
  return {
    artifactDirectory: options.artifactDirectory,
    absoluteArtifactDirectory: absolute_artifact_directory,
    submissionDebugPath: join(absolute_artifact_directory, "submission-debug.json"),
    networkPath: join(absolute_artifact_directory, "network.json"),
    buttonAuditPath: join(absolute_artifact_directory, "button-audit.json"),
    submitCandidatesPath: join(absolute_artifact_directory, "submit-candidates.json"),
    beforeSubmitScreenshotPath: join(absolute_artifact_directory, "before-submit.png"),
    afterSubmit2sScreenshotPath: join(absolute_artifact_directory, "after-submit-2s.png"),
    afterConfirmationWaitScreenshotPath: join(
      absolute_artifact_directory,
      "after-confirmation-wait.png",
    ),
  };
}

/*
 * ========================================================================
 * VISIBLE MESSAGE COLLECTION - collect_visible_message_candidates(...)
 * ========================================================================
 * Input:  The page after submit was clicked.
 * Output: Visible toast/status/message candidates.
 *
 * Responsibility: Capture post-submit page evidence without deciding whether
 * each message is a confirmation.
 * ========================================================================
 */
export async function collect_visible_message_candidates(
  page: Page,
): Promise<MessageCandidateDebugInfo[]> {
  const selectors = [
    '[role="alert"]',
    '[role="status"]',
    "[aria-live]",
    ".toast",
    ".snackbar",
    ".alert",
    ".notification",
    ".message",
    ".success",
    ".error",
  ];
  const candidates: MessageCandidateDebugInfo[] = [];

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const frame_candidates = await frame
        .locator(selector)
        .evaluateAll((elements, selected_selector) =>
          elements
            .map((element) => {
              const html_element = element as HTMLElement;
              const rectangle = html_element.getBoundingClientRect();
              const style = window.getComputedStyle(html_element);
              const visible =
                rectangle.width > 0 &&
                rectangle.height > 0 &&
                style.visibility !== "hidden" &&
                style.display !== "none";
              const text = (html_element.innerText || html_element.textContent || "")
                .trim()
                .replace(/\s+/g, " ");

              return visible && text
                ? {
                    selector: String(selected_selector),
                    text,
                  }
                : undefined;
            })
            .filter(
              (candidate): candidate is { selector: string; text: string } =>
                Boolean(candidate),
            ),
          selector,
        )
        .catch(() => []);

      for (const candidate of frame_candidates) {
        candidates.push({
          ...candidate,
          frameUrl: frame.url(),
        });
      }
    }
  }

  return dedupe_message_candidates(candidates).slice(0, 20);
}

/*
 * ========================================================================
 * SUBMISSION DEBUG FINALIZATION - finalize_submission_debug(...)
 * ========================================================================
 * Input:  Submission state, network records, audit events, and page evidence.
 * Output: Short debug summary for the main report.
 *
 * Responsibility: Write heavy observability artifacts to JSON/PNG files and
 * return only concise report lines to the caller.
 * ========================================================================
 */
export async function finalize_submission_debug({
  page,
  debugContext,
  urlBeforeSubmission,
  submitControl,
  verifiedSubmitTarget,
  submitClickDispatched,
  submitClickTimestamp,
  originalSubmitCandidate,
  preflightInterceptor,
  submitCandidates,
  postSubmitMessages,
  invalidControls,
  preSubmitValidation,
  networkRecords,
  buttonAuditEvents,
  confirmed,
  postClickDisposition,
  rejectionEvidence,
  confirmationEvidence,
  networkSubmissionEvidence,
  confirmationControlClicked,
  captchaAssessment,
  obstructionActions,
  clickError,
  noSubmitReason,
  redactionValues,
}: FinalizeSubmissionDebugInput): Promise<SubmissionDebugSummary | undefined> {
  if (!debugContext) {
    return undefined;
  }

  await safe_page_screenshot(
    page,
    debugContext.afterConfirmationWaitScreenshotPath,
    redactionValues,
  );
  const url_after_submission = page.url();
  const debug_document = {
    artifactDirectory: debugContext.artifactDirectory,
    screenshots: {
      beforeSubmit: "before-submit.png",
      afterSubmit2s: "after-submit-2s.png",
      afterConfirmationWait: "after-confirmation-wait.png",
    },
    submitControl: submitControl ?? null,
    submitDispatch: {
      verifiedTarget: verifiedSubmitTarget,
      targetKind: submit_target_kind(submitControl),
      clickDispatched: submitClickDispatched,
      clickTimestamp: submitClickTimestamp ?? null,
      originalCandidate: originalSubmitCandidate ?? null,
      preflightInterceptor: preflightInterceptor ?? null,
    },
    submitCandidates,
    buttonAudit: buttonAuditEvents,
    obstructionActions: obstructionActions ?? [],
    urlBeforeSubmission,
    urlAfterSubmission: url_after_submission,
    postSubmit: {
      waitedMs: 2_000,
      messageFound: postSubmitMessages.length > 0,
      messageCandidates: postSubmitMessages,
    },
    invalidControls,
    ...(preSubmitValidation ? { preSubmitValidation } : {}),
    confirmationControlClicked,
    postClickDisposition: postClickDisposition ?? "unconfirmed",
    rejectionEvidence: rejectionEvidence ?? [],
    confirmationEvidence,
    networkSubmissionEvidence: {
      found: networkSubmissionEvidence.found,
      confirmsSubmission: networkSubmissionEvidence.confirmsSubmission,
      rejectsSubmission: networkSubmissionEvidence.rejectsSubmission ?? false,
      confidence: networkSubmissionEvidence.confidence,
      summary: networkSubmissionEvidence.summary,
      reason: networkSubmissionEvidence.reason,
      ...(networkSubmissionEvidence.bestRequest
        ? { bestRequest: networkSubmissionEvidence.bestRequest }
        : {}),
      ...(networkSubmissionEvidence.bestRejectionRequest
        ? {
            bestRejectionRequest:
              networkSubmissionEvidence.bestRejectionRequest,
          }
        : {}),
      ...(networkSubmissionEvidence.providerRuleId
        ? { providerRuleId: networkSubmissionEvidence.providerRuleId }
        : {}),
      ...(networkSubmissionEvidence.rejectionCategory
        ? { rejectionCategory: networkSubmissionEvidence.rejectionCategory }
        : {}),
    },
    confirmed,
    ...(captchaAssessment ? { captcha: captchaAssessment } : {}),
    ...(clickError ? { clickError } : {}),
    ...(noSubmitReason ? { noSubmitReason } : {}),
  };
  const safe_debug_document = sanitize_debug_artifact(
    debug_document,
    redactionValues ?? [],
  );

  await writeFile(
    debugContext.submissionDebugPath,
    `${JSON.stringify(safe_debug_document, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    debugContext.networkPath,
    `${JSON.stringify(
      sanitize_debug_artifact({ requests: networkRecords }, redactionValues ?? []),
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    debugContext.buttonAuditPath,
    `${JSON.stringify(
      sanitize_debug_artifact({ buttonClicks: buttonAuditEvents }, redactionValues ?? []),
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    debugContext.submitCandidatesPath,
    `${JSON.stringify(
      sanitize_debug_artifact({ candidates: submitCandidates }, redactionValues ?? []),
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    artifactDirectory: debugContext.artifactDirectory,
    selectedSubmitControl: submitControl
      ? summarize_button_control(submitControl)
      : "none",
    verifiedSubmitTarget,
    submitTargetKind: submit_target_kind(submitControl),
    submitClickDispatched,
    ...(submitClickTimestamp ? { submitClickTimestamp } : {}),
    ...(originalSubmitCandidate ? { originalSubmitCandidate } : {}),
    ...(preflightInterceptor
      ? { preflightInterceptor: summarize_hit_test_receiver(preflightInterceptor) }
      : {}),
    postSubmitMessageFound: postSubmitMessages.length > 0,
    urlBeforeSubmission,
    urlAfterSubmission: url_after_submission,
    ...(postClickDisposition ? { postClickDisposition } : {}),
    ...(rejectionEvidence
      ? {
          rejectionEvidenceCount: rejectionEvidence.length,
          rejectionCategories: [
            ...new Set(rejectionEvidence.map((evidence) => evidence.category)),
          ],
        }
      : {}),
    confirmationEvidence,
    networkRequestCount: networkRecords.length,
    networkSubmissionEvidenceFound: networkSubmissionEvidence.found,
    networkSubmissionEvidenceConfidence: networkSubmissionEvidence.confidence,
    networkSubmissionEvidenceSummary: networkSubmissionEvidence.summary,
    networkSubmissionEvidenceReason: networkSubmissionEvidence.reason,
    networkSubmissionRejectsSubmission:
      networkSubmissionEvidence.rejectsSubmission ?? false,
    ...(networkSubmissionEvidence.providerRuleId
      ? {
          networkSubmissionProviderRuleId:
            networkSubmissionEvidence.providerRuleId,
        }
      : {}),
    ...(networkSubmissionEvidence.bestRequest
      ? { bestNetworkSubmissionRequest: networkSubmissionEvidence.bestRequest }
      : {}),
    buttonClickCount: buttonAuditEvents.length,
    buttonClickSummaries: buttonAuditEvents.map(summarize_button_click),
    captchaPresenceBefore: captchaAssessment?.before.presence ?? "none",
    captchaPresenceAfter: captchaAssessment?.after.presence ?? "none",
    captchaBlocked: captchaAssessment?.blocked ?? false,
    ...(captchaAssessment?.reason
      ? { captchaBlockReason: captchaAssessment.reason }
      : {}),
    ...(preSubmitValidation
      ? {
          preSubmitValidationApplicability:
            preSubmitValidation.final.applicability,
          ...(preSubmitValidation.final.bypassReason
            ? {
                preSubmitValidationBypassReason:
                  preSubmitValidation.final.bypassReason,
              }
            : {}),
          preSubmitValid: preSubmitValidation.final.valid,
          populationRecoveryAttempted:
            preSubmitValidation.recovery.attempted === true,
          populationRecoverySucceeded:
            preSubmitValidation.recovery.succeeded === true,
          inactiveConditionalControlsDisabled:
            preSubmitValidation.inactiveConditionalControls?.checkpoints.reduce(
              (maximum, checkpoint) =>
                Math.max(maximum, checkpoint.disabledControls.length),
              0,
            ) ?? 0,
          inactiveConditionalControlsRestored:
            preSubmitValidation.inactiveConditionalControls?.restorations.reduce(
              (total, restoration) => total + restoration.result.restored,
              0,
            ) ?? 0,
        }
      : {}),
  };
}

function submit_target_kind(
  control: ButtonControlDebugInfo | undefined,
): SubmissionDebugSummary["submitTargetKind"] {
  if (!control) {
    return "none";
  }
  if (control.tag === "a") {
    return "nonNavigationalAnchor";
  }
  if (control.type.toLowerCase() === "submit") {
    return "nativeSubmit";
  }
  return "customControl";
}

function summarize_hit_test_receiver(receiver: {
  tag: string;
  id: string;
  className: string;
  text: string;
}): string {
  const identity = `${receiver.tag}${receiver.id ? `#${receiver.id}` : ""}${
    receiver.className
      ? `.${receiver.className.trim().replace(/\s+/g, ".")}`
      : ""
  }`;
  return receiver.text ? `${identity}: ${receiver.text}` : identity;
}

/*
 * ========================================================================
 * STEP_LEVEL_HELPER_FUNCTIONS
 * ========================================================================
 *
 * safe_page_screenshot(...)       - Capture screenshots without failing workflow.
 * dedupe_message_candidates(...)  - Remove duplicate visible messages.
 * ========================================================================
 */

export async function safe_page_screenshot(
  page: Page,
  path: string,
  redaction_values: string[] = [],
): Promise<void> {
  await with_masked_page_values(
    page,
    redaction_values,
    () => page.screenshot({ path, fullPage: true, animations: "disabled" }),
  ).catch(() => undefined);
}

function dedupe_message_candidates(
  candidates: MessageCandidateDebugInfo[],
): MessageCandidateDebugInfo[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.frameUrl}\n${candidate.selector}\n${candidate.text}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function sanitize_debug_artifact(
  value: unknown,
  redaction_values: string[],
  key = "",
): unknown {
  if (typeof value === "string") {
    if (/authorization|cookie|token|password|secret|api.?key|session/i.test(key)) {
      return "[redacted-secret]";
    }
    let result = value;
    for (const secret of [...redaction_values].sort(
      (left, right) => right.length - left.length,
    )) {
      if (secret.trim().length < 2) continue;
      result = result.replace(
        new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        "[redacted-contact-value]",
      );
    }
    return result
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
      .replace(
        /(?:\+\d[\d\s().-]{6,}\d|\(\d{2,4}\)[\d\s.-]{4,}\d|\d{2,4}[ -]\d{3,4}[ -]\d{3,4})/g,
        "[redacted-phone]",
      )
      .replace(
        /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
        "[redacted-token]",
      )
      .replace(/\b(?:[a-f0-9]{40,}|[A-Za-z0-9+/=_-]{64,})\b/gi, "[redacted-high-entropy]")
      .slice(0, 4_000);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize_debug_artifact(item, redaction_values, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([child_key, child_value]) => [
        child_key,
        sanitize_debug_artifact(child_value, redaction_values, child_key),
      ]),
    );
  }
  return value;
}
