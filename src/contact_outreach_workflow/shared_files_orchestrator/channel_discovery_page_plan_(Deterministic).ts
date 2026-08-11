import { MAX_CONTACT_LINKS } from "./outreach_constants_(Support).js";
import type { ContactRouteDiscoveryResult } from "./outreach_types_(Support).js";

export function build_bounded_channel_page_plan(
  routes: ContactRouteDiscoveryResult,
): string[] {
  const starting_url = normalize_http_url(routes.startingUrl);
  if (!starting_url) {
    return [];
  }

  const target_origin = new URL(starting_url).origin;
  const planned_pages = [starting_url];
  const seen = new Set(planned_pages);
  let accepted_candidates = 0;

  for (const candidate of routes.candidates) {
    if (accepted_candidates >= MAX_CONTACT_LINKS) {
      break;
    }
    const normalized = normalize_http_url(candidate.url);
    if (
      !normalized ||
      new URL(normalized).origin !== target_origin ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    planned_pages.push(normalized);
    accepted_candidates += 1;
  }

  return planned_pages;
}

function normalize_http_url(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
