import type { Page } from "playwright";
import type {
  ContactRouteCandidate,
  ContactRouteDiscoveryResult,
} from "../../shared_files_orchestrator/outreach_types_(Support).js";
import { score_contact_route } from "./C2_contact_route_scoring_(Deterministic).js";

export async function discover_contact_routes(
  page: Page,
): Promise<ContactRouteDiscoveryResult> {
  return {
    startingUrl: page.url(),
    candidates: await collect_ranked_contact_routes(page),
  };
}

async function collect_ranked_contact_routes(
  page: Page,
): Promise<ContactRouteCandidate[]> {
  const current_url = new URL(page.url());
  const routes_by_url = new Map<string, ContactRouteCandidate>();

  for (const frame of page.frames()) {
    const frame_url = frame.url() || page.url();
    if (
      frame_url !== "about:blank" &&
      safe_url_origin(frame_url) !== current_url.origin
    ) {
      continue;
    }
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
