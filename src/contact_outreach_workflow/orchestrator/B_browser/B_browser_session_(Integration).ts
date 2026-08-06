import { chromium } from "playwright";
import {
  ACTION_TIMEOUT_MS,
  AUTOMATION_ENGINE_ENVIRONMENT_VARIABLE,
  DEBUG_ACTION_SLOW_MO_MS,
  is_contact_form_debug_enabled,
  NAVIGATION_TIMEOUT_MS,
} from "../../shared_files_orchestrator/outreach_constants_(Support).js";
import { describe_error } from "../../shared_files_orchestrator/outreach_errors_(Support).js";
import type {
  AutomationEngine,
  ContactFillValues,
  OutreachBrowserSession,
} from "../../shared_files_orchestrator/outreach_types_(Support).js";
import { start_network_debug_recorder } from "../../shared_files_orchestrator/network_debug_(Support).js";
import {
  create_lazy_stagehand_attachment,
  reserve_loopback_cdp_port,
  wait_for_cdp_websocket_url,
} from "./B2_stagehand_browser_session_(Integration).js";

/*
 * TOP LEVEL WORKFLOW:
 *
 * open_target_website(contact_request)
 *        |
 *        v
 * launch Chromium
 *        |
 *        v
 * open a new page
 *        |
 *        v
 * navigate to the target website
 */

/*
 * ========================================================================
 * TOP_LEVEL_WORKFLOW_FUNCTIONS
 * ========================================================================
 */

/*
 * ========================================================================
 * TARGET WEBSITE OPENING - open_target_website(...)
 * ========================================================================
 * Input:  A validated contact request containing the target URL.
 * Output: An active Chromium browser and page positioned at the target site.
 *
 * Responsibility: Create browser resources and perform the bounded initial
 * navigation without leaking Chromium when navigation fails.
 * ========================================================================
 */
export async function open_target_website(
  contact_request: { websiteUrl: string } & Partial<ContactFillValues>,
  options: BrowserSessionOptions = {},
): Promise<OutreachBrowserSession> {
  const engine = resolve_automation_engine(options.engine, options.environment);
  const debug_enabled = is_contact_form_debug_enabled();
  const cdp_port = engine === "stagehand"
    ? await reserve_loopback_cdp_port()
    : undefined;
  const browser = await chromium.launch({
    headless: !debug_enabled,
    ...(debug_enabled ? { slowMo: DEBUG_ACTION_SLOW_MO_MS } : {}),
    ...(cdp_port
      ? {
          args: [
            "--remote-debugging-address=127.0.0.1",
            `--remote-debugging-port=${cdp_port}`,
          ],
        }
      : {}),
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    configure_page_timeouts(page);
    const network_debug_recorder = options.networkDebug
      ? start_network_debug_recorder(
          page,
          options.networkDebug.redactionValues ?? [],
        )
      : undefined;
    let initial_navigation_error: string | undefined;
    try {
      await page.goto(contact_request.websiteUrl, {
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch (error) {
      if (!options.allowNavigationFailure) throw error;
      initial_navigation_error = describe_error(error);
    }
    const stagehand_attachment =
      cdp_port
        ? create_lazy_stagehand_attachment({
            cdpUrl: () =>
              wait_for_cdp_websocket_url(cdp_port, NAVIGATION_TIMEOUT_MS),
            ...(options.environment ? { environment: options.environment } : {}),
          })
        : undefined;
    const session: OutreachBrowserSession = {
      page,
      context,
      createChannelPage: async () => {
        const channel_page = await context.newPage();
        configure_page_timeouts(channel_page);
        return channel_page;
      },
      ...(initial_navigation_error
        ? { initialNavigationError: initial_navigation_error }
        : {}),
      redactionValues: contact_request_redaction_values(contact_request),
      obstructionActions: [],
      close: async () => {
        await stagehand_attachment?.close();
        await browser.close();
      },
      ...(network_debug_recorder
        ? { networkDebugRecorder: network_debug_recorder }
        : {}),
    };
    if (stagehand_attachment) {
      Object.defineProperty(session, "pageIntelligence", {
        enumerable: true,
        configurable: false,
        get: () => stagehand_attachment.current(),
      });
      session.ensurePageIntelligence = stagehand_attachment.ensure;
    }
    return session;
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw new Error(
      `Could not open the target website${engine === "stagehand" ? " for Stagehand attachment" : ""}: ${describe_error(error)}`,
    );
  }
}

function contact_request_redaction_values(
  contact_request: { websiteUrl: string } & Partial<ContactFillValues>,
): string[] {
  return [
    contact_request.name,
    contact_request.email,
    contact_request.phone,
    contact_request.message,
    contact_request.company,
    contact_request.role,
    contact_request.website,
    contact_request.country,
  ].filter((value): value is string => Boolean(value));
}

function configure_page_timeouts(
  page: OutreachBrowserSession["page"],
): void {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
}

export function resolve_automation_engine(
  explicit_engine: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): AutomationEngine {
  const engine =
    explicit_engine ?? environment[AUTOMATION_ENGINE_ENVIRONMENT_VARIABLE];
  if (engine === undefined || engine === "" || engine === "playwright") {
    return "playwright";
  }
  if (engine === "stagehand") {
    return "stagehand";
  }

  throw new Error(
    `Invalid ${AUTOMATION_ENGINE_ENVIRONMENT_VARIABLE} value. ` +
      'Expected "playwright" or "stagehand".',
  );
}

export interface BrowserSessionOptions {
  engine?: AutomationEngine;
  environment?: NodeJS.ProcessEnv;
  allowNavigationFailure?: boolean;
  networkDebug?: {
    redactionValues?: string[];
  };
}
