import type { Page } from "playwright";
import { build_bounded_channel_page_plan } from "../../../../shared_files_orchestrator/channel_discovery_page_plan_(Deterministic).js";
import { describe_error } from "../../../../shared_files_orchestrator/outreach_errors_(Support).js";
import type { ContactRouteDiscoveryResult } from "../../../../shared_files_orchestrator/outreach_types_(Support).js";
import type { EmailDiscoveryResult } from "../../shared_files_emails/email_types_(Support).js";
import {
  extract_usable_emails_from_page,
} from "./A2_email_extraction_(Deterministic).js";

const EMAIL_PAGE_SETTLE_MS = 250;

export async function discover_published_emails(
  page: Page,
  routes: ContactRouteDiscoveryResult,
  sender_email: string,
): Promise<EmailDiscoveryResult> {
  const planned_pages = build_bounded_channel_page_plan(routes);
  const inspected_pages: string[] = [];
  const failed_pages: EmailDiscoveryResult["failedPages"] = [];
  const emails = new Set<string>();
  const target_origin = new URL(routes.startingUrl).origin;

  for (const planned_url of planned_pages) {
    try {
      const response = await page.goto(planned_url, {
        waitUntil: "domcontentloaded",
      });
      if (response && !response.ok()) {
        throw new Error(`HTTP ${response.status()} ${response.statusText()}`.trim());
      }
      if (safe_url_origin(page.url()) !== target_origin) {
        throw new Error(
          `Navigation left the target origin and ended at ${page.url()}`,
        );
      }

      await wait_for_email_page_readiness(page);
      const page_emails = await extract_usable_emails_from_page(page, {
        senderEmail: sender_email,
        targetOrigin: target_origin,
      });
      for (const email of page_emails) {
        emails.add(email);
      }
      inspected_pages.push(planned_url);
    } catch (error) {
      failed_pages.push({
        url: planned_url,
        reason: describe_error(error),
      });
    }
  }

  return {
    emails: [...emails].sort((left, right) => left.localeCompare(right)),
    plannedPages: planned_pages,
    inspectedPages: inspected_pages,
    failedPages: failed_pages,
  };
}

async function wait_for_email_page_readiness(page: Page): Promise<void> {
  await page
    .waitForLoadState("networkidle", { timeout: 3_000 })
    .catch(() => undefined);
  await page
    .waitForFunction(
      () => Boolean(document.body?.innerText.trim() || document.querySelector("a[href]")),
      undefined,
      { timeout: 3_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(EMAIL_PAGE_SETTLE_MS);
}

function safe_url_origin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}
