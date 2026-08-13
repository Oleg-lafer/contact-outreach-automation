import type { Locator, Page } from "playwright";
import type { NetworkDebugRecord } from "./forms_types_(Support).js";

/*
 * CAPTCHA integration is not itself a failure. The workflow records whether
 * provider markup is passive or visibly interactive, then continues without
 * solving or interacting with it. Only post-submit evidence may prove that a
 * CAPTCHA physically blocked the form.
 */
export const CAPTCHA_SELECTOR = [
  'iframe[src*="recaptcha" i]',
  'iframe[src*="hcaptcha" i]',
  'iframe[src*="turnstile" i]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
  "[data-sitekey]",
].join(", ");

const CAPTCHA_ERROR_SELECTOR = [
  "[role=alert]",
  "[aria-live]",
  '[class*="error" i]',
  '[id*="error" i]',
].join(", ");

const CAPTCHA_BLOCKING_TEXT =
  /captcha|recaptcha|hcaptcha|turnstile|verify (?:that )?you(?: are|'re)|not a robot|robot verification|verification (?:is )?required|verification failed/i;

export type CaptchaPresence = "none" | "passive" | "interactive";

export interface CaptchaAssessment {
  presence: CaptchaPresence;
  matchedCount: number;
  visibleCount: number;
  evidence: string[];
  visibleErrorTexts: string[];
}

export interface CaptchaBlockAssessment {
  blocked: boolean;
  reason?: string;
  before: CaptchaAssessment;
  after: CaptchaAssessment;
  visibleErrorText?: string;
}

export async function assess_page_captcha(page: Page): Promise<CaptchaAssessment> {
  let matched_count = 0;
  let visible_count = 0;
  const evidence = new Set<string>();

  for (const frame of page.frames()) {
    const locator = frame.locator(CAPTCHA_SELECTOR);
    const count = await locator.count().catch(() => 0);
    matched_count += count;
    for (let index = 0; index < Math.min(count, 20); index += 1) {
      const element = locator.nth(index);
      const visible = await element.isVisible().catch(() => false);
      if (visible) {
        visible_count += 1;
      }
      const description = await element
        .evaluate((node) => {
          const html = node as HTMLElement;
          return [
            node.tagName.toLowerCase(),
            html.id ? `#${html.id}` : "",
            typeof html.className === "string" && html.className
              ? `.${html.className.trim().replace(/\s+/g, ".")}`
              : "",
            node.getAttribute("src") ?? "",
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 300);
        })
        .catch(() => "captcha element");
      evidence.add(`${visible ? "visible" : "hidden"}: ${description}`);
    }
  }

  return {
    presence:
      matched_count === 0
        ? "none"
        : visible_count > 0
          ? "interactive"
          : "passive",
    matchedCount: matched_count,
    visibleCount: visible_count,
    evidence: [...evidence].slice(0, 20),
    visibleErrorTexts: await find_visible_captcha_errors(page),
  };
}

export async function assess_captcha_blockage(
  page: Page,
  before: CaptchaAssessment,
  submit_click_dispatched: boolean,
): Promise<CaptchaBlockAssessment> {
  const after = await assess_page_captcha(page);
  const before_errors = new Set(before.visibleErrorTexts);
  const visible_error_text = submit_click_dispatched
    ? after.visibleErrorTexts.find((text) => !before_errors.has(text))
    : undefined;
  const challenge_activated =
    submit_click_dispatched &&
    before.presence !== "interactive" &&
    after.presence === "interactive";
  const blocked = Boolean(visible_error_text || challenge_activated);

  return {
    blocked,
    ...(visible_error_text
      ? {
          reason: `CAPTCHA physically blocked submission: ${visible_error_text}`,
          visibleErrorText: visible_error_text,
        }
      : challenge_activated
        ? {
            reason:
              "CAPTCHA physically blocked submission: an interactive challenge appeared after submit",
          }
        : {}),
    before,
    after,
  };
}

export async function captcha_blocks_submit_activation(
  form: Locator,
  assessment: CaptchaAssessment,
): Promise<string | undefined> {
  if (assessment.presence !== "interactive") {
    return undefined;
  }
  const controls = form.locator(
    'button, input[type="submit"], input[type="button"], [role="button"]',
  );
  const count = Math.min(await controls.count().catch(() => 0), 30);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const state = await control
      .evaluate((element) => {
        const html = element as HTMLElement;
        const input = element as HTMLInputElement;
        const label = [
          html.innerText,
          input.value,
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("name"),
          html.id,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return {
          visible:
            html.getBoundingClientRect().width > 0 &&
            html.getBoundingClientRect().height > 0 &&
            getComputedStyle(html).visibility !== "hidden" &&
            getComputedStyle(html).display !== "none",
          disabled:
            input.disabled || element.getAttribute("aria-disabled") === "true",
          submitLike:
            input.type === "submit" ||
            /\b(send|submit|message|contact|request|continue|finish)\b|שלח|שלחו|שליחה|הודעה|צור קשר|בקשה|המשך|סיום/u.test(
              label,
            ),
        };
      })
      .catch(() => undefined);
    if (state?.visible && state.disabled && state.submitLike) {
      return "CAPTCHA physically blocked submission: the submit control is disabled while an interactive challenge is visible";
    }
  }
  return undefined;
}

export function add_captcha_network_rejection(
  assessment: CaptchaBlockAssessment,
  records: NetworkDebugRecord[],
): CaptchaBlockAssessment {
  if (assessment.blocked) {
    return assessment;
  }
  const rejected = records.find(
    (record) => {
      const evidence =
        `${record.url} ${record.postDataPreview ?? ""} ${record.failureText ?? ""}`;
      const captcha_related =
        /captcha|recaptcha|hcaptcha|turnstile|challenge/i.test(evidence);
      const explicit_rejection =
        /reject|denied|forbidden|invalid|failed|failure|required|blocked|נדחה|נכשל|שגוי|לא תקין|חובה|נדרש|חסום/iu.test(
          evidence,
        );
      return (
        record.method !== "GET" &&
        captcha_related &&
        ((record.status ?? 0) >= 400 ||
          Boolean(record.failureText) ||
          explicit_rejection)
      );
    },
  );
  if (!rejected) {
    return assessment;
  }
  return {
    ...assessment,
    blocked: true,
    reason: `CAPTCHA physically blocked submission: the form request was rejected${rejected.status ? ` with HTTP ${rejected.status}` : ""}`,
  };
}

/** Compatibility helper for callers that only need to know markup presence. */
export async function page_contains_captcha(page: Page): Promise<boolean> {
  return (await assess_page_captcha(page)).presence !== "none";
}

export async function selector_targets_captcha(
  page: Page,
  selector: string,
): Promise<boolean> {
  for (const frame of page.frames()) {
    let candidates: Locator;
    try {
      candidates = frame.locator(selector);
    } catch {
      continue;
    }
    const count = Math.min(await candidates.count().catch(() => 0), 10);
    for (let index = 0; index < count; index += 1) {
      const is_captcha = await candidates
        .nth(index)
        .evaluate(
          (element, captcha_selector) =>
            element.matches(captcha_selector) ||
            Boolean(element.closest(captcha_selector)),
          CAPTCHA_SELECTOR,
        )
        .catch(() => false);
      if (is_captcha) {
        return true;
      }
    }
  }
  return false;
}

async function find_visible_captcha_errors(page: Page): Promise<string[]> {
  const errors = new Set<string>();
  for (const frame of page.frames()) {
    const candidates = frame.locator(CAPTCHA_ERROR_SELECTOR);
    const count = Math.min(await candidates.count().catch(() => 0), 50);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }
      const text = ((await candidate.innerText().catch(() => "")) || "")
        .trim()
        .replace(/\s+/g, " ");
      if (text && CAPTCHA_BLOCKING_TEXT.test(text)) {
        errors.add(text.slice(0, 300));
      }
    }
  }
  return [...errors].slice(0, 20);
}
