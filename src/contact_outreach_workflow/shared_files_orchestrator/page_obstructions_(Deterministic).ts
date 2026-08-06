import type { Frame, Locator, Page } from "playwright";
import type {
  CookieConsentVendor,
  PageObstructionAction,
} from "./outreach_types_(Support).js";

const MAX_COOKIE_ACTIONS = 3;
const COOKIE_CONTAINER_SELECTOR = [
  "#onetrust-banner-sdk",
  "#onetrust-pc-sdk",
  ".onetrust-pc-dark-filter",
  "#tarteaucitronAlertBig",
  "#tarteaucitronRoot",
  "#CybotCookiebotDialog",
  "#CybotCookiebotDialogBodyUnderlay",
  "#usercentrics-root",
  '[data-testid*="uc-" i]',
  '[class*="ccm-" i]',
  '[id*="ccm-" i]',
  "#cookie-law-info-bar",
  ".cli-modal-backdrop",
  ".cky-consent-container",
  "#sliding-popup",
  ".eu-cookie-compliance-banner",
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[class*="cookie" i]',
  '[id*="cookie" i]',
  '[class*="consent" i]',
  '[id*="consent" i]',
  '[class*="privacy" i]',
  '[id*="privacy" i]',
].join(", ");

const COOKIE_TEXT =
  /cookie|consent|privacy|tracking|personal data|confidentialit|vie priv[ée]e|donn[ée]es personnelles|datenschutz|einwilligung|zustimmung|functionele|toestemming|privacidad|seguimiento|dados pessoais|privacidade|куки|согласие/i;
const CONTROL_SELECTOR = [
  "button",
  '[role="button"]',
  'input[type="button"]',
  'input[type="submit"]',
  "a[href]",
].join(", ");

interface CookieControlCandidate {
  control: Locator;
  label: string;
  score: number;
  action: PageObstructionAction["action"];
}

interface CookieObstructionCandidate {
  blocker: Locator;
  control: CookieControlCandidate;
  vendor: CookieConsentVendor;
  detectionBasis: NonNullable<PageObstructionAction["detectionBasis"]>;
}

/**
 * Dismisses one clearly identified cookie/privacy obstruction. This
 * compatibility wrapper is used by discovery and population. Submission
 * preflight uses the bounded coordinator below.
 */
export async function dismiss_cookie_obstruction(
  page: Page,
  target?: Locator,
): Promise<PageObstructionAction | undefined> {
  return dismiss_one_cookie_obstruction(page, target, 1);
}

/**
 * Resolves at most three verified cookie/CMP layers. The action ordering is
 * privacy-preserving: reject, necessary-only, and close always outrank accept.
 */
export async function dismiss_cookie_obstructions(
  page: Page,
  target?: Locator,
  maximum_actions = MAX_COOKIE_ACTIONS,
): Promise<PageObstructionAction[]> {
  const actions: PageObstructionAction[] = [];
  const bounded_maximum = Math.max(
    0,
    Math.min(MAX_COOKIE_ACTIONS, maximum_actions),
  );

  for (let attempt = 1; attempt <= bounded_maximum; attempt += 1) {
    const action = await dismiss_one_cookie_obstruction(page, target, attempt);
    if (!action) {
      break;
    }
    actions.push(action);
    if (action.cleared) {
      break;
    }
  }

  return actions;
}

async function dismiss_one_cookie_obstruction(
  page: Page,
  target: Locator | undefined,
  attempt: number,
): Promise<PageObstructionAction | undefined> {
  const candidate = await find_cookie_obstruction(page, target);
  if (!candidate) {
    return undefined;
  }

  const base = {
    kind: "cookieConsent" as const,
    action: candidate.control.action,
    label: candidate.control.label,
    vendor: candidate.vendor,
    attempt,
    detectionBasis: candidate.detectionBasis,
    blockingVerified: true,
  };

  try {
    await candidate.control.control.click({ timeout: 3_000 });
    await page.waitForTimeout(350).catch(() => undefined);
    const verification = await verify_obstruction_cleared(
      candidate.blocker,
      target,
    );
    return {
      ...base,
      result: "clicked",
      cleared: verification.cleared,
      verificationReason: verification.reason,
    };
  } catch (error) {
    return {
      ...base,
      result: "failed",
      cleared: false,
      verificationReason: "the selected consent control could not be activated",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function find_cookie_obstruction(
  page: Page,
  target: Locator | undefined,
): Promise<CookieObstructionCandidate | undefined> {
  for (const frame of page.frames()) {
    const containers = frame.locator(COOKIE_CONTAINER_SELECTOR);
    const count = Math.min(await containers.count().catch(() => 0), 60);
    for (let index = 0; index < count; index += 1) {
      const blocker = containers.nth(index);
      if (!(await blocker.isVisible().catch(() => false))) {
        continue;
      }

      const vendor = await identify_vendor(blocker);
      const text = await blocker.innerText().catch(() => "");
      const detection_basis =
        vendor === "generic"
          ? COOKIE_TEXT.test(text)
            ? "consentText"
            : undefined
          : "knownVendor";
      if (!detection_basis) {
        continue;
      }

      const blocks = target
        ? await container_obstructs_target(blocker, target)
        : await is_page_obstruction(blocker);
      if (!blocks) {
        continue;
      }

      const selected = await select_cookie_control(frame, blocker, vendor);
      if (!selected) {
        continue;
      }
      return {
        blocker,
        control: selected,
        vendor,
        detectionBasis: detection_basis,
      };
    }
  }
  return undefined;
}

async function identify_vendor(
  container: Locator,
): Promise<CookieConsentVendor> {
  return container
    .evaluate((element) => {
      const identity = [
        element.id,
        element.className,
        element.getAttribute("data-testid"),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (/onetrust/.test(identity)) return "oneTrust" as const;
      if (/tarteaucitron/.test(identity)) return "tarteaucitron" as const;
      if (/cybot|cookiebot/.test(identity)) return "cookiebot" as const;
      if (/usercentrics|\buc-/.test(identity)) return "usercentrics" as const;
      if (/\bccm[-_]/.test(identity)) return "ccm19" as const;
      if (/cookie-law-info|\bcli-|cookieyes|\bcky-/.test(identity)) {
        return "cookieYes" as const;
      }
      if (/sliding-popup|eu-cookie-compliance/.test(identity)) {
        return "drupal" as const;
      }
      return "generic" as const;
    })
    .catch(() => "generic");
}

async function is_page_obstruction(container: Locator): Promise<boolean> {
  return container
    .evaluate((element) => {
      const html = element as HTMLElement;
      const rectangle = html.getBoundingClientRect();
      const style = getComputedStyle(html);
      const viewport_area = Math.max(1, innerWidth * innerHeight);
      const coverage = (rectangle.width * rectangle.height) / viewport_area;
      return (
        element.getAttribute("aria-modal") === "true" ||
        element.getAttribute("role") === "dialog" ||
        (["fixed", "sticky"].includes(style.position) && coverage >= 0.05)
      );
    })
    .catch(() => false);
}

async function select_cookie_control(
  frame: Frame,
  container: Locator,
  vendor: CookieConsentVendor,
): Promise<CookieControlCandidate | undefined> {
  const candidates = await collect_control_candidates(
    container.locator(CONTROL_SELECTOR),
  );

  if (vendor !== "generic") {
    const vendor_containers = frame.locator(vendor_container_selector(vendor));
    candidates.push(
      ...(await collect_control_candidates(
        vendor_containers.locator(CONTROL_SELECTOR),
        vendor,
      )),
    );
  }

  const unique = new Map<string, CookieControlCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.action}\n${candidate.label}\n${candidate.score}`;
    if (!unique.has(key)) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()].sort(
    (left, right) => right.score - left.score,
  )[0];
}

function vendor_container_selector(vendor: CookieConsentVendor): string {
  switch (vendor) {
    case "oneTrust":
      return "#onetrust-banner-sdk, #onetrust-pc-sdk, .onetrust-pc-dark-filter";
    case "tarteaucitron":
      return "#tarteaucitronAlertBig, #tarteaucitronRoot";
    case "cookiebot":
      return "#CybotCookiebotDialog, #CybotCookiebotDialogBodyUnderlay";
    case "usercentrics":
      return '#usercentrics-root, [data-testid*="uc-" i]';
    case "ccm19":
      return '[class*="ccm-" i], [id*="ccm-" i]';
    case "cookieYes":
      return "#cookie-law-info-bar, .cli-modal-backdrop, .cky-consent-container";
    case "drupal":
      return "#sliding-popup, .eu-cookie-compliance-banner";
    case "generic":
      return COOKIE_CONTAINER_SELECTOR;
  }
}

async function collect_control_candidates(
  controls: Locator,
  vendor?: CookieConsentVendor,
): Promise<CookieControlCandidate[]> {
  const candidates: CookieControlCandidate[] = [];
  const count = Math.min(await controls.count().catch(() => 0), 80);
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (
      !(await control.isVisible().catch(() => false)) ||
      !(await control.isEnabled().catch(() => false))
    ) {
      continue;
    }
    const metadata = await control
      .evaluate((element) => ({
        label: [
          (element as HTMLElement).innerText,
          element.getAttribute("value"),
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
        ]
          .filter(Boolean)
          .join(" ")
          .trim()
          .replace(/\s+/g, " "),
        identity: [
          element.id,
          element.className,
          element.getAttribute("data-testid"),
          element.getAttribute("name"),
        ]
          .filter(Boolean)
          .join(" "),
      }))
      .catch(() => ({ label: "", identity: "" }));
    const ranked =
      rank_known_vendor_control(metadata.identity, vendor) ??
      rank_cookie_control(metadata.label);
    if (ranked) {
      candidates.push({
        control,
        label: metadata.label || metadata.identity,
        ...ranked,
      });
    }
  }
  return candidates;
}

function rank_known_vendor_control(
  identity: string,
  vendor: CookieConsentVendor | undefined,
): { score: number; action: PageObstructionAction["action"] } | undefined {
  if (!vendor) {
    return undefined;
  }
  const normalized = identity.toLowerCase();
  if (
    /reject-all|decline|alldenied|deny-all|optindecline|btn-reject|cookie_action_close_header_reject/.test(
      normalized,
    )
  ) {
    return { score: 500, action: "reject" };
  }
  if (/necessary|essential|functional|save-settings|save-preference/.test(normalized)) {
    return { score: 450, action: "necessaryOnly" };
  }
  if (/close-btn|btn-close|dismiss/.test(normalized)) {
    return { score: 400, action: "close" };
  }
  if (/accept-all|allow-all|allallowed|btn-accept|agree-button/.test(normalized)) {
    return { score: 100, action: "accept" };
  }
  return undefined;
}

function rank_cookie_control(
  label: string,
): { score: number; action: PageObstructionAction["action"] } | undefined {
  const normalized = label.normalize("NFKC").toLowerCase();
  if (
    /reject|decline|deny|refuse|do not allow|rejeter|refuser|rechazar|ablehnen|weigern|alles afwijzen|weigeren|recusar|rejeitar|отклонить|отказать/.test(
      normalized,
    )
  ) {
    return { score: 500, action: "reject" };
  }
  if (
    /necessary|essential|functional only|save preferences|uniquement n[ée]cessaires|nur notwendige|enkel functionele|solo necesarias|apenas necess[áa]rios|только необходимые/.test(
      normalized,
    )
  ) {
    return { score: 450, action: "necessaryOnly" };
  }
  if (
    /continue without|without accepting|close|dismiss|fermer|schlie(?:ß|ss)en|sluiten|cerrar|fechar|закрыть|\u00d7|\u2715/.test(
      normalized,
    )
  ) {
    return { score: 400, action: "close" };
  }
  if (
    /accept|allow|agree|okay|^ok$|got it|accepter|tout accepter|akzeptieren|alles accepteren|aceptar|aceitar|разрешить|принять|хорошо/.test(
      normalized,
    )
  ) {
    return { score: 100, action: "accept" };
  }
  return undefined;
}

async function container_obstructs_target(
  container: Locator,
  target: Locator,
): Promise<boolean> {
  const target_handle = await target.elementHandle().catch(() => null);
  if (!target_handle) {
    return false;
  }
  try {
    return await container
      .evaluate((element, target_element) => {
        const target_html = target_element as HTMLElement;
        const rectangle = target_html.getBoundingClientRect();
        if (rectangle.width <= 0 || rectangle.height <= 0) {
          return false;
        }
        const receiver = target_html.ownerDocument.elementFromPoint(
          rectangle.left + rectangle.width / 2,
          rectangle.top + rectangle.height / 2,
        );
        return Boolean(
          receiver &&
            (receiver === element ||
              element.contains(receiver) ||
              receiver.contains(element)),
        );
      }, target_handle)
      .catch(() => false);
  } finally {
    await target_handle.dispose().catch(() => undefined);
  }
}

async function verify_obstruction_cleared(
  blocker: Locator,
  target: Locator | undefined,
): Promise<{ cleared: boolean; reason: string }> {
  if (target) {
    const receives_pointer = await target
      .evaluate((element) => {
        const html = element as HTMLElement;
        const rectangle = html.getBoundingClientRect();
        if (rectangle.width <= 0 || rectangle.height <= 0) {
          return false;
        }
        const receiver = html.ownerDocument.elementFromPoint(
          rectangle.left + rectangle.width / 2,
          rectangle.top + rectangle.height / 2,
        );
        return Boolean(
          receiver &&
            (receiver === element ||
              element.contains(receiver) ||
              receiver.contains(element)),
        );
      })
      .catch(() => false);
    return {
      cleared: receives_pointer,
      reason: receives_pointer
        ? "the submit control receives the center-point hit test"
        : "the consent layer still intercepts the submit control",
    };
  }

  const still_visible = await blocker.isVisible().catch(() => false);
  return {
    cleared: !still_visible,
    reason: still_visible
      ? "the consent container remained visible"
      : "the consent container became hidden or detached",
  };
}
