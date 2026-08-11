import type { Page } from "playwright";

const NETWORK_IDLE_TIMEOUT_MS = 15_000;
const VISIBLE_CONTENT_TIMEOUT_MS = 10_000;
const SETTLE_TIMEOUT_MS = 1_000;

export async function wait_for_discovery_readiness(page: Page): Promise<void> {
  await page
    .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS })
    .catch(() => undefined);
  await page
    .waitForFunction(page_has_visible_content_or_controls, undefined, {
      timeout: VISIBLE_CONTENT_TIMEOUT_MS,
    })
    .catch(() => undefined);
  await page.waitForTimeout(SETTLE_TIMEOUT_MS);
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
