import type { Frame, Page } from "playwright";
import type {
  MeetingEvidenceKind,
  MeetingProvider,
  MeetingSchedulingLink,
} from "../../shared_files_meetings/meeting_types_(Support).js";
import {
  normalize_bilingual_text,
  safely_decode_url_text,
} from "../../../../shared_files_orchestrator/bilingual_text_(Deterministic).js";

const EN_BUSINESS_MEETING = String.raw`\b(?:book|schedule)\s+(?:a\s+)?(?:meeting|call|demo|consultation|discovery(?:\s+call)?|strategy(?:\s+session)?|time)\b|\b(?:talk|speak)\s+(?:to|with)\s+(?:sales|an?\s+expert|our\s+team|us)\b|\bmeet\s+with\s+(?:sales|an?\s+expert|our\s+team|us)\b`;
const HE_BUSINESS_MEETING = String.raw`קבעו פגישה|קביעת פגישה|תיאום פגישה|הזמנת פגישה|קבעו שיחה|תיאום שיחה|שיחת ייעוץ|פגישת ייעוץ|שיחת היכרות|פגישת היכרות|הדגמה|דמו|דברו עם המכירות|שיחה עם מומחה|פגישה עם הצוות`;
const BUSINESS_MEETING_PATTERN = new RegExp(
  `(?:${EN_BUSINESS_MEETING})|(?:${HE_BUSINESS_MEETING})`,
  "iu",
);
const EXCLUDED_CONTEXT_PATTERN =
  /\b(?:webinar|conference|class(?:es)?|course|training|workshop|interview|career(?:s)?|candidate|job|support|help\s*desk|medical|doctor|clinic|patient|therapy|therapist|dental|dentist|salon|spa|service\s+appointment|restaurant|table\s+reservation|hotel|room\s+reservation|rental)\b|וובינר|כנס|קורס|הדרכה|סדנה|ראיון עבודה|קריירה|מועמד|משרה|תמיכה|מוקד שירות|רופא|מרפאה|מטופל|טיפול|מטפל|רופא שיניים|מספרה|ספא|תור לשירות|מסעדה|הזמנת שולחן|מלון|הזמנת חדר|השכרה/iu;
const EXCLUDED_PATH_PATTERN =
  /(?:^|[-_/])(?:webinars?|conferences?|classes?|courses?|training|workshops?|interviews?|careers?|candidates?|jobs?|support|medical|doctors?|clinics?|patients?|therapy|dental|dentists?|salons?|spas?|restaurants?|reservations?|hotels?|rentals?|וובינר|כנס|קורס|הדרכה|סדנה|ראיון|קריירה|דרושים|תמיכה|רופא|מרפאה|טיפול|מסעדה|הזמנה|מלון|השכרה)(?:[-_/]|$)/iu;
const PROVIDER_MARKETING_PATH_PATTERN =
  /^\/(?:pricing|features|about|blog|login|signup|integrations|solutions|resources|contact|careers|docs|help|app)(?:\/|$)/i;

export interface MeetingCandidateInput {
  rawUrl: string;
  attribute: "href" | "src" | "data-url" | "data-calendly-url" | "data-cal-link";
  label: string;
  context: string;
  kind: MeetingEvidenceKind;
  baseUrl: string;
  sourcePageUrl: string;
}

export async function extract_meeting_scheduling_links_from_page(
  page: Page,
  target_origin: string,
): Promise<MeetingSchedulingLink[]> {
  const links_by_url = new Map<string, MeetingSchedulingLink>();

  for (const frame of page.frames()) {
    if (!is_inspectable_frame(frame, target_origin)) {
      continue;
    }
    const base_url =
      !frame.url() || frame.url() === "about:blank"
        ? page.url()
        : frame.url();
    const raw_candidates = await collect_visible_candidates(frame);

    for (const raw_candidate of raw_candidates) {
      const classified = classify_meeting_candidate({
        ...raw_candidate,
        baseUrl: base_url,
        sourcePageUrl: base_url,
      });
      if (!classified) {
        continue;
      }
      merge_meeting_link(links_by_url, classified);
    }
  }

  return sort_meeting_links([...links_by_url.values()]);
}

export function classify_meeting_candidate(
  candidate: MeetingCandidateInput,
): MeetingSchedulingLink | undefined {
  const url = normalize_candidate_url(
    candidate.rawUrl,
    candidate.attribute,
    candidate.baseUrl,
  );
  if (!url) {
    return undefined;
  }

  const provider = identify_meeting_provider(url);
  const searchable = normalize_text(
    `${candidate.label} ${candidate.context} ${decode_url_searchable(url)}`,
  );
  const negative_searchable = normalize_text(
    `${candidate.label} ${candidate.context}`,
  );
  const path = safely_decode_url_text(new URL(url).pathname);
  if (
    EXCLUDED_CONTEXT_PATTERN.test(negative_searchable) ||
    EXCLUDED_PATH_PATTERN.test(path)
  ) {
    return undefined;
  }

  const provider_is_actionable =
    provider !== "custom" && is_actionable_provider_url(url, provider);
  if (!provider_is_actionable && !BUSINESS_MEETING_PATTERN.test(searchable)) {
    return undefined;
  }

  const label = normalize_text(candidate.label);
  return {
    url,
    provider,
    sources: [
      {
        pageUrl: candidate.sourcePageUrl,
        kind: candidate.kind,
        ...(label ? { label } : {}),
      },
    ],
  };
}

export function merge_meeting_links(
  links: MeetingSchedulingLink[],
): MeetingSchedulingLink[] {
  const links_by_url = new Map<string, MeetingSchedulingLink>();
  for (const link of links) {
    merge_meeting_link(links_by_url, link);
  }
  return sort_meeting_links([...links_by_url.values()]);
}

function merge_meeting_link(
  links_by_url: Map<string, MeetingSchedulingLink>,
  discovered: MeetingSchedulingLink,
): void {
  const existing = links_by_url.get(discovered.url);
  if (!existing) {
    links_by_url.set(discovered.url, {
      ...discovered,
      sources: sort_sources([...discovered.sources]),
    });
    return;
  }

  const sources_by_key = new Map(
    existing.sources.map((source) => [source_key(source), source]),
  );
  for (const source of discovered.sources) {
    sources_by_key.set(source_key(source), source);
  }
  existing.sources = sort_sources([...sources_by_key.values()]);
}

function sort_meeting_links(
  links: MeetingSchedulingLink[],
): MeetingSchedulingLink[] {
  return links.sort((left, right) => left.url.localeCompare(right.url));
}

function sort_sources(
  sources: MeetingSchedulingLink["sources"],
): MeetingSchedulingLink["sources"] {
  return sources.sort(
    (left, right) =>
      left.pageUrl.localeCompare(right.pageUrl) ||
      left.kind.localeCompare(right.kind) ||
      (left.label ?? "").localeCompare(right.label ?? ""),
  );
}

function source_key(source: MeetingSchedulingLink["sources"][number]): string {
  return `${source.pageUrl}\u0000${source.kind}\u0000${source.label ?? ""}`;
}

function normalize_candidate_url(
  raw_url: string,
  attribute: MeetingCandidateInput["attribute"],
  base_url: string,
): string | undefined {
  const trimmed = raw_url.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidate_url =
    attribute === "data-cal-link" && !/^https?:\/\//i.test(trimmed)
      ? `https://cal.com/${trimmed.replace(/^\/+/, "")}`
      : trimmed;
  try {
    const url = new URL(candidate_url, base_url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function identify_meeting_provider(url_value: string): MeetingProvider {
  const hostname = new URL(url_value).hostname.toLowerCase();
  if (hostname === "calendly.com") return "calendly";
  if (hostname === "cal.com") return "cal.com";
  if (hostname === "meetings.hubspot.com") return "hubspot";
  if (hostname === "chilipiper.com" || hostname.endsWith(".chilipiper.com")) {
    return "chili-piper";
  }
  return "custom";
}

function is_actionable_provider_url(
  url_value: string,
  provider: Exclude<MeetingProvider, "custom">,
): boolean {
  const url = new URL(url_value);
  if (PROVIDER_MARKETING_PATH_PATTERN.test(url.pathname)) {
    return false;
  }
  switch (provider) {
    case "calendly":
    case "cal.com":
    case "hubspot":
      return url.pathname !== "/";
    case "chili-piper":
      return /\/book(?:\/|$)/i.test(url.pathname);
  }
}

function decode_url_searchable(url_value: string): string {
  const url = new URL(url_value);
  try {
    return decodeURIComponent(`${url.pathname} ${url.hash}`);
  } catch {
    return `${url.pathname} ${url.hash}`;
  }
}

function normalize_text(value: string): string {
  return normalize_bilingual_text(value).slice(0, 1_000);
}

function is_inspectable_frame(frame: Frame, target_origin: string): boolean {
  const frame_url = frame.url();
  if (!frame_url || frame_url === "about:blank") {
    return true;
  }
  try {
    return new URL(frame_url).origin === target_origin;
  } catch {
    return false;
  }
}

async function collect_visible_candidates(
  frame: Frame,
): Promise<
  Array<
    Omit<
      MeetingCandidateInput,
      "baseUrl" | "sourcePageUrl"
    >
  >
> {
  return frame
    .locator(
      "a[href], iframe[src], [data-url], [data-calendly-url], [data-cal-link]",
    )
    .evaluateAll((elements) => {
      return elements.flatMap((element) => {
        let current: Element | null = element;
        while (current) {
          if (
            current.hasAttribute("hidden") ||
            current.getAttribute("aria-hidden") === "true"
          ) {
            return [];
          }
          const style = window.getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            style.opacity === "0"
          ) {
            return [];
          }
          current = current.parentElement;
        }
        if (element.getClientRects().length === 0) {
          return [];
        }
        const label = [
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
        ]
          .filter(Boolean)
          .join(" ")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 1_000);
        const container = element.closest(
          "section, article, li, nav, header, footer, div",
        );
        const context = [
          container?.querySelector("h1, h2, h3")?.textContent,
          container?.textContent,
        ]
          .filter(Boolean)
          .join(" ")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 1_000);
        const candidates: Array<{
          rawUrl: string;
          attribute:
            | "href"
            | "src"
            | "data-url"
            | "data-calendly-url"
            | "data-cal-link";
          label: string;
          context: string;
          kind: "visible_link" | "embedded_widget";
        }> = [];
        const attributes: Array<{
          attribute:
            | "href"
            | "src"
            | "data-url"
            | "data-calendly-url"
            | "data-cal-link";
          kind: "visible_link" | "embedded_widget";
          applicable: boolean;
        }> = [
          {
            attribute: "href",
            kind: "visible_link",
            applicable: element.matches("a[href]"),
          },
          {
            attribute: "src",
            kind: "embedded_widget",
            applicable: element.matches("iframe[src]"),
          },
          {
            attribute: "data-calendly-url",
            kind: "embedded_widget",
            applicable: element.hasAttribute("data-calendly-url"),
          },
          {
            attribute: "data-url",
            kind: "embedded_widget",
            applicable: element.hasAttribute("data-url"),
          },
          {
            attribute: "data-cal-link",
            kind: "embedded_widget",
            applicable: element.hasAttribute("data-cal-link"),
          },
        ];
        for (const item of attributes) {
          if (!item.applicable) {
            continue;
          }
          const raw_url = element.getAttribute(item.attribute) ?? "";
          if (raw_url) {
            candidates.push({
              rawUrl: raw_url,
              attribute: item.attribute,
              label,
              context,
              kind: item.kind,
            });
          }
        }
        return candidates;
      });
    });
}
