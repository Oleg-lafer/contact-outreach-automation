import type { Page } from "playwright";

const NETWORK_IDLE_TIMEOUT_MS = 15_000;
const VISIBLE_CONTENT_TIMEOUT_MS = 10_000;
const SETTLE_TIMEOUT_MS = 1_000;

export interface DiscoveryReadinessResult {
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  networkIdle: "reached" | "timed_out";
  visibleContentReady: boolean;
  readyState: string;
  stateChangedDuringSettle: boolean;
}

export async function wait_for_discovery_readiness(page: Page): Promise<DiscoveryReadinessResult> {
  const started_at = new Date().toISOString();
  const started = performance.now();
  const before = await readiness_state(page);
  const network_idle = await page
    .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS })
    .then(() => "reached" as const)
    .catch(() => "timed_out" as const);
  const visible_content_ready = await page
    .waitForFunction(page_has_visible_content_or_controls, undefined, {
      timeout: VISIBLE_CONTENT_TIMEOUT_MS,
    })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(SETTLE_TIMEOUT_MS);
  const after = await readiness_state(page);
  return {
    startedAt: started_at,
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
    networkIdle: network_idle,
    visibleContentReady: visible_content_ready,
    readyState: after.readyState,
    stateChangedDuringSettle:
      before.readyState !== after.readyState ||
      before.formCount !== after.formCount ||
      before.bodyLength !== after.bodyLength,
  };
}

async function readiness_state(page: Page): Promise<{ readyState: string; formCount: number; bodyLength: number }> {
  return page.evaluate(() => ({
    readyState: document.readyState,
    formCount: document.querySelectorAll("form").length,
    bodyLength: document.body?.innerText.length ?? 0,
  })).catch(() => ({ readyState: "unknown", formCount: 0, bodyLength: 0 }));
}

function page_has_visible_content_or_controls(): boolean {
  const selectors = [
    "a[href]",
    "button",
    "form",
    "input:not([type='hidden'])",
    "select",
    "textarea",
  ];
  const visible = (element: Element): boolean => {
    const style = window.getComputedStyle(element);
    const rectangle = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rectangle.width > 0 &&
      rectangle.height > 0
    );
  };
  return (
    selectors.some((selector) =>
      Array.from(document.querySelectorAll(selector)).some(visible),
    ) || Boolean(document.body?.innerText.trim())
  );
}
