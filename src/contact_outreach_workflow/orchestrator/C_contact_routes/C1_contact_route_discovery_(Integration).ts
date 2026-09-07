import type { Page } from "playwright";
import type {
  ContactRouteCandidate,
  ContactRouteDiscoveryResult,
} from "../../shared_files_orchestrator/outreach_types_(Support).js";
import { score_contact_route } from "./C2_contact_route_scoring_(Deterministic).js";
import type { DeepDebugContext } from "../../shared_files_orchestrator/deep_debug_types_(Support).js";

export const CONTACT_ROUTE_SCAN_TIMEOUT_MS = 10_000;

export class ContactRouteScanTimeoutError extends Error {
  public constructor(
    public readonly timeoutMs: number,
    public readonly activeFrameUrl: string | undefined,
    public readonly completedFrames: number,
    public readonly discoveredLinks: number,
  ) {
    super(`Contact-link scanning timed out after ${timeoutMs} ms.`);
    this.name = "ContactRouteScanTimeoutError";
  }
}

interface ContactRouteDiscoveryOptions {
  timeoutMs?: number;
  deepDebug?: DeepDebugContext;
}

export async function discover_contact_routes(
  page: Page,
  options: ContactRouteDiscoveryOptions = {},
): Promise<ContactRouteDiscoveryResult> {
  const timeout_ms = options.timeoutMs ?? CONTACT_ROUTE_SCAN_TIMEOUT_MS;
  const started_at = Date.now();
  const progress = { activeFrameUrl: undefined as string | undefined, completedFrames: 0, discoveredLinks: 0 };
  options.deepDebug?.record({
    stage: "orchestrator", substage: "contact-route-discovery",
    operation: "scan-contact-links", outcome: "started", url: page.url(),
    data: { timeoutMs: timeout_ms, frameCount: page.frames().length },
  });

  let timeout: NodeJS.Timeout | undefined;
  const scan = collect_ranked_contact_routes(page, options.deepDebug, progress);
  try {
    const candidates = await Promise.race([
      scan,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new ContactRouteScanTimeoutError(
          timeout_ms,
          progress.activeFrameUrl,
          progress.completedFrames,
          progress.discoveredLinks,
        )), timeout_ms);
      }),
    ]);
    options.deepDebug?.record({
      stage: "orchestrator", substage: "contact-route-discovery",
      operation: "scan-contact-links", outcome: "succeeded", url: page.url(),
      durationMs: Date.now() - started_at,
      data: { completedFrames: progress.completedFrames, discoveredLinks: progress.discoveredLinks, candidateCount: candidates.length },
    });
    return { startingUrl: page.url(), candidates };
  } catch (error) {
    if (error instanceof ContactRouteScanTimeoutError) {
      options.deepDebug?.record({
        stage: "orchestrator", substage: "contact-route-discovery",
        operation: "scan-contact-links", outcome: "failed",
        reason: error.message, url: page.url(),
        ...(error.activeFrameUrl ? { frameUrl: error.activeFrameUrl } : {}),
        durationMs: Date.now() - started_at,
        data: { timeoutMs: error.timeoutMs, completedFrames: error.completedFrames, discoveredLinks: error.discoveredLinks },
      });
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    void scan.catch(() => undefined);
  }
}

async function collect_ranked_contact_routes(
  page: Page,
  deep_debug: DeepDebugContext | undefined,
  progress: { activeFrameUrl: string | undefined; completedFrames: number; discoveredLinks: number },
): Promise<ContactRouteCandidate[]> {
  const current_url = new URL(page.url());
  const routes_by_url = new Map<string, ContactRouteCandidate>();

  for (const [frame_index, frame] of page.frames().entries()) {
    const frame_url = frame.url() || page.url();
    if (
      frame_url !== "about:blank" &&
      safe_url_origin(frame_url) !== current_url.origin
    ) {
      continue;
    }
    progress.activeFrameUrl = frame_url;
    const frame_started_at = Date.now();
    deep_debug?.record({
      stage: "orchestrator", substage: "contact-route-discovery",
      operation: "scan-frame-links", outcome: "started", url: page.url(), frameUrl: frame_url,
      data: { frameOrdinal: frame_index + 1 },
    });
    const raw_links = await frame
      .locator("a[href]")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const container = element.closest(
            "nav, header, footer, section, article, main",
          );
          return {
            href: element.getAttribute("href") ?? "",
            text: [
              element.textContent,
              element.getAttribute("aria-label"),
              element.getAttribute("title"),
            ]
              .filter(Boolean)
              .join(" ")
              .trim()
              .toLowerCase(),
            context: [
              container?.getAttribute("aria-label"),
              container?.querySelector("h1, h2, h3")?.textContent,
            ]
              .filter(Boolean)
              .join(" ")
              .trim()
              .toLowerCase(),
          };
        }),
      )
      .catch(() => []);
    progress.completedFrames++;
    progress.discoveredLinks += raw_links.length;
    deep_debug?.record({
      stage: "orchestrator", substage: "contact-route-discovery",
      operation: "scan-frame-links", outcome: "succeeded", url: page.url(), frameUrl: frame_url,
      durationMs: Date.now() - frame_started_at,
      data: { frameOrdinal: frame_index + 1, discoveredLinks: raw_links.length },
    });

    for (const link of raw_links) {
      if (!link.href || /^(mailto|tel|javascript):/i.test(link.href)) {
        continue;
      }
      let url: URL;
      try {
        url = new URL(
          link.href,
          frame_url === "about:blank" ? page.url() : frame_url,
        );
      } catch {
        continue;
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.origin !== current_url.origin
      ) {
        continue;
      }

      const searchable =
        `${link.text} ${link.context} ${url.pathname.toLowerCase()} ${url.hash.toLowerCase()}`;
      let score = score_contact_route(searchable) + 3;
      if (url.hash && url.pathname === current_url.pathname) {
        score += 2;
      }
      if (score === 3) {
        continue;
      }

      const existing = routes_by_url.get(url.toString());
      if (!existing || score > existing.score) {
        routes_by_url.set(url.toString(), {
          url: url.toString(),
          score,
          label: link.text || link.context,
        });
      }
    }
  }

  progress.activeFrameUrl = undefined;

  return [...routes_by_url.values()].sort(
    (left, right) => right.score - left.score,
  );
}

function safe_url_origin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}
