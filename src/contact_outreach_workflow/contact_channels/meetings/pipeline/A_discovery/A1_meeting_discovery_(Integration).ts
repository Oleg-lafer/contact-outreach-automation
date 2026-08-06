import type { Page, Route } from "playwright";
import { build_bounded_channel_page_plan } from "../../../../shared_files_orchestrator/channel_discovery_page_plan_(Deterministic).js";
import { describe_error } from "../../../../shared_files_orchestrator/outreach_errors_(Support).js";
import type { ContactRouteDiscoveryResult } from "../../../../shared_files_orchestrator/outreach_types_(Support).js";
import type { MeetingDiscoveryResult } from "../../shared_files_meetings/meeting_types_(Support).js";
import {
  extract_meeting_scheduling_links_from_page,
  merge_meeting_links,
} from "./A2_meeting_link_classification_(Deterministic).js";

const MEETING_PAGE_SETTLE_MS = 250;

export async function discover_meeting_scheduling_links(
  page: Page,
  routes: ContactRouteDiscoveryResult,
): Promise<MeetingDiscoveryResult> {
  const planned_pages = build_bounded_channel_page_plan(routes);
  const inspected_pages: string[] = [];
  const failed_pages: MeetingDiscoveryResult["failedPages"] = [];
  const discovered_links: MeetingDiscoveryResult["meetingLinks"] = [];
  const target_origin = new URL(routes.startingUrl).origin;
  const block_cross_origin_documents = async (route: Route): Promise<void> => {
    const request = route.request();
    if (
      request.resourceType() === "document" &&
      safe_url_origin(request.url()) !== target_origin
    ) {
      await route.abort();
      return;
    }
    await route.continue();
  };
  await page.route("**/*", block_cross_origin_documents);

  try {
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

        await wait_for_meeting_page_readiness(page);
        discovered_links.push(
          ...(await extract_meeting_scheduling_links_from_page(
            page,
            target_origin,
          )),
        );
        inspected_pages.push(planned_url);
      } catch (error) {
        failed_pages.push({
          url: planned_url,
          reason: describe_error(error),
        });
      }
    }
  } finally {
    await page
      .unroute("**/*", block_cross_origin_documents)
      .catch(() => undefined);
  }

  return {
    meetingLinks: merge_meeting_links(discovered_links),
    plannedPages: planned_pages,
    inspectedPages: inspected_pages,
    failedPages: failed_pages,
  };
}

async function wait_for_meeting_page_readiness(page: Page): Promise<void> {
  await page
    .waitForLoadState("load", { timeout: 3_000 })
    .catch(() => undefined);
  await page
    .waitForFunction(
      () =>
        Boolean(
          document.body?.innerText.trim() ||
            document.querySelector(
              "a[href], iframe[src], [data-url], [data-calendly-url], [data-cal-link]",
            ),
        ),
      undefined,
      { timeout: 3_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(MEETING_PAGE_SETTLE_MS);
}

function safe_url_origin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}
