import type { Page } from "playwright";
import type {
  ButtonClickAuditEvent,
  ButtonControlDebugInfo,
  SubmitControlSearchResult,
} from "./C2_submission_types_(Support).js";

/*
 * TOP LEVEL WORKFLOW:
 *
 * create_button_click_audit_event(page, action, control, result, sequence)
 *        |
 *        v
 * describe_button_control(control, result)
 *        |
 *        v
 * mark_button_click_succeeded(...) / mark_button_click_failed(...)
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * BUTTON CLICK AUDIT CREATION - create_button_click_audit_event(...)
 * ========================================================================
 * Input:  Page state, click action name, selected control, and search result.
 * Output: A pending ordered button-click audit event.
 *
 * Responsibility: Capture button identity before clicking so failures still
 * leave evidence about which control was selected.
 * ========================================================================
 */
export async function create_button_click_audit_event(
  page: Page,
  action_name: ButtonClickAuditEvent["actionName"],
  control: SubmitControlSearchResult["control"],
  result: SubmitControlSearchResult,
  sequence_number: number,
): Promise<ButtonClickAuditEvent> {
  if (!control) {
    throw new Error("button audit requires a selected control");
  }

  return {
    sequenceNumber: sequence_number,
    actionName: action_name,
    pageUrlBeforeClick: page.url(),
    timestamp: new Date().toISOString(),
    clickResult: "pending",
    ...(await describe_button_control(control, result)),
  };
}

/*
 * ========================================================================
 * BUTTON CONTROL DESCRIPTION - describe_button_control(...)
 * ========================================================================
 * Input:  A selected button-like control and its search result.
 * Output: Stable metadata for reports and artifacts.
 *
 * Responsibility: Record what Playwright selected using DOM text, attributes,
 * strategy details, and bounding box evidence.
 * ========================================================================
 */
export async function describe_button_control(
  control: NonNullable<SubmitControlSearchResult["control"]>,
  result: SubmitControlSearchResult,
): Promise<ButtonControlDebugInfo> {
  const element_info = await control.evaluate((element) => ({
    frameUrl: element.ownerDocument.location.href,
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute("type") ?? "",
    text: (element.textContent ?? "").trim().replace(/\s+/g, " "),
    value: element.getAttribute("value") ?? "",
    name: element.getAttribute("name") ?? "",
    id: element.id,
    ariaLabel: element.getAttribute("aria-label") ?? "",
    title: element.getAttribute("title") ?? "",
  }));

  return {
    selectorStrategy: result.strategy ?? "unknown",
    selector: result.selector ?? "",
    selectedIndex: result.selectedIndex ?? null,
    score: result.score ?? null,
    ...element_info,
    boundingBox: await control.boundingBox().catch(() => null),
  };
}

/*
 * ========================================================================
 * STEP_LEVEL_HELPER_FUNCTIONS
 * ========================================================================
 *
 * mark_button_click_succeeded(...) - Mark a pending audit event as clicked.
 * mark_button_click_failed(...)    - Mark a pending audit event as failed.
 * summarize_button_control(...)    - Format selected submit control for report.
 * summarize_button_click(...)      - Format one button click for report.
 * button_label(...)                - Choose the best human-readable label.
 * ========================================================================
 */

export function mark_button_click_succeeded(event: ButtonClickAuditEvent): void {
  event.clickResult = "clicked";
}

export function mark_button_click_failed(
  event: ButtonClickAuditEvent,
  error: string,
): void {
  event.clickResult = "failed";
  event.error = error;
}

export function summarize_button_control(control: ButtonControlDebugInfo): string {
  const label = button_label(control);
  const identifier = control.id ? `#${control.id}` : control.name;
  return [
    control.tag,
    control.type ? `type=${control.type}` : "",
    label ? `text="${label}"` : "",
    identifier ? `id/name=${identifier}` : "",
    control.selectorStrategy ? `strategy=${control.selectorStrategy}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function summarize_button_click(event: ButtonClickAuditEvent): string {
  const label = button_label(event) || "(no button text)";
  const result = event.clickResult === "failed" ? " failed" : "";
  return `${event.actionName} - "${label}"${result}`;
}

function button_label(control: ButtonControlDebugInfo): string {
  return control.text || control.value || control.ariaLabel || control.title;
}
