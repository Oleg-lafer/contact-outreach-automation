import type { Page } from "playwright";
import { has_contact_route_intent } from "../../../../orchestrator/C_contact_routes/C2_contact_route_scoring_(Deterministic).js";
import type {
  FormDiscoveryResult,
  DiscoveryEvidenceRecord,
  FormDiscoveryOutcome,
  DiscoveryPageSignals,
  NetworkDebugRecord,
  PresenceEvidenceStrength,
} from "../../shared_files_forms/forms_types_(Support).js";

const FORM_PROVIDER_PATTERN =
  /hubspot|hsforms|marketo|pardot|salesforce|jotform|typeform|formstack|wufoo|gravityforms|gravity_form|calendly|cal\.com/i;
const FORM_RESOURCE_PATTERN =
  /contact|inquir|enquir|lead|form|quote|consult|booking|book-a-call|request|message|submit|submission/i;
const ANALYTICS_PATTERN =
  /google-analytics|googletagmanager|doubleclick|segment\.io|hotjar|clarity|facebook\.com\/tr|linkedin\.com\/px|analytics/i;

export async function collect_discovery_page_signals(
  page: Page,
): Promise<DiscoveryPageSignals> {
  const page_signals = await page
    .evaluate(() => {
      const body_context = [
        document.title,
        window.location.pathname,
        ...Array.from(document.querySelectorAll("h1, h2, h3"))
          .slice(0, 20)
          .map((heading) => heading.textContent ?? ""),
      ].join(" ");
      const links = Array.from(document.querySelectorAll("a[href]"));
      const channels: string[] = [];
      if (links.some((link) => /^mailto:/i.test(link.getAttribute("href") ?? ""))) {
        channels.push("email");
      }
      if (links.some((link) => /^tel:/i.test(link.getAttribute("href") ?? ""))) {
        channels.push("telephone");
      }
      if (
        links.some((link) =>
          /whatsapp|livechat|intercom|messenger|tawk\.to|crisp\.chat/i.test(
            `${link.getAttribute("href") ?? ""} ${link.textContent ?? ""}`,
          ),
        )
      ) {
        channels.push("chat");
      }
      if (/support|help center|help desk/i.test(body_context)) {
        channels.push("support");
      }
      if (
        links.some((link) => {
          const href = link.getAttribute("href") ?? "";
          const label = `${link.textContent ?? ""} ${link.getAttribute("aria-label") ?? ""}`;
          try {
            return (
              new URL(href, window.location.href).origin !== window.location.origin &&
              /book|schedule|appointment|calendly|cal\.com/i.test(`${href} ${label}`)
            );
          } catch {
            return false;
          }
        })
      ) {
        channels.push("externalBooking");
      }

      const resource_urls = Array.from(
        document.querySelectorAll("iframe[src], script[src]"),
      )
        .map((element) => element.getAttribute("src") ?? "")
        .filter(Boolean);
      const controls = Array.from(
        document.querySelectorAll("button, [role='button'], a:not([href])"),
      )
        .filter((element) => {
          const html_element = element as HTMLElement;
          const style = window.getComputedStyle(html_element);
          const bounds = html_element.getBoundingClientRect();
          return (
            !element.closest("form") &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            bounds.width > 0 &&
            bounds.height > 0
          );
        })
        .map((element) =>
          [
            element.textContent,
            element.getAttribute("aria-label"),
            element.getAttribute("title"),
          ]
            .filter(Boolean)
            .join(" ")
            .trim()
            .replace(/\s+/g, " "),
        )
        .filter((label) =>
          /contact|get in touch|inquir|enquir|consult|book|schedule|quote|proposal|start.*project|work with us|audit|talk to us/i.test(
            label,
          ),
        )
        .slice(0, 10);
      return { bodyContext: body_context, channels, resourceUrls: resource_urls, controls };
    });

  const frame_urls = page.frames().map((frame) => frame.url()).filter(Boolean);
  const recognized_embeds = [...page_signals.resourceUrls, ...frame_urls]
    .filter((url) => FORM_PROVIDER_PATTERN.test(url))
    .map(safe_url);
  const valid_channels = page_signals.channels.filter(
    is_contact_channel,
  ) as DiscoveryPageSignals["contactChannels"];
  const contact_channels = [
    ...new Set<DiscoveryPageSignals["contactChannels"][number]>(
      valid_channels,
    ),
  ];
  return {
    contactContext: has_contact_route_intent(
      `${page.url()} ${page_signals.bodyContext}`,
    ),
    contactChannels: contact_channels,
    recognizedFormEmbeds: [...new Set(recognized_embeds)],
    contactRevealControls: [...new Set(page_signals.controls)],
  };
}

export function create_discovery_outcome(options: {
  websiteUrl: string;
  finalUrl: string;
  discoveryResult: FormDiscoveryResult;
  pageSignals: DiscoveryPageSignals;
  networkRecords: NetworkDebugRecord[];
  assessedAt?: string;
}): FormDiscoveryOutcome {
  const {
    websiteUrl,
    finalUrl,
    discoveryResult,
    pageSignals,
    networkRecords,
  } = options;
  const evidence: DiscoveryEvidenceRecord[] = [];
  const limitations: string[] = [];
  const debug = discoveryResult.debug;
  const rejected_candidates = debug?.candidates.filter((candidate) => !candidate.accepted) ?? [];

  if (discoveryResult.candidate) {
    evidence.push({
      kind: "validatedContactForm",
      strength: "strong",
      description: `Playwright validated a ${discoveryResult.candidate.classification ?? "contact"} form candidate`,
      url: safe_url(discoveryResult.candidate.frame.url() || finalUrl),
    });
  }
  for (const url of pageSignals.recognizedFormEmbeds) {
    evidence.push({
      kind: "recognizedFormEmbed",
      strength: pageSignals.contactContext ? "strong" : "moderate",
      description: pageSignals.contactContext
        ? "recognized form-provider embed appeared in contact context"
        : "recognized form-provider resource appeared without enough contact context",
      url,
    });
  }
  evidence.push(
    ...network_form_evidence(
      networkRecords,
      pageSignals,
      debug?.interactions ?? [],
    ),
  );

  for (const route of debug?.attemptedRoutes ?? []) {
    if (route.result === "opened") {
      evidence.push({
        kind: "contactRoute",
        strength: "weak",
        description: `opened ranked contact destination: ${route.label || route.url}`,
        url: safe_url(route.url),
      });
    } else if (route.result === "failed" || route.result === "blocked") {
      limitations.push(
        `contact destination could not be inspected: ${route.label || safe_url(route.url)}`,
      );
    }
  }
  for (const control of pageSignals.contactRevealControls) {
    evidence.push({
      kind: "contactRevealControl",
      strength: "weak",
      description: `visible contact-oriented reveal control: ${control}`,
    });
  }
  for (const channel of pageSignals.contactChannels) {
    evidence.push({
      kind: "contactChannel",
      strength: "weak",
      description: `contact channel observed: ${format_channel(channel)}`,
    });
  }
  for (const candidate of rejected_candidates) {
    if (
      candidate.signals.hasContactContext &&
      /could not be inspected|no visible submit|no visible email|sufficient contact shape|message field/i.test(
        candidate.reason,
      )
    ) {
      evidence.push({
        kind: "rejectedForm",
        strength: "weak",
        description: `contact-like form candidate remained inconclusive: ${candidate.reason}`,
        url: safe_url(candidate.url),
      });
    }
  }
  if (discoveryResult.transportFailure) {
    limitations.push(discoveryResult.reason ?? "a ranked contact route was inaccessible");
  }
  if (
    (debug?.candidates ?? []).some((candidate) =>
      /could not be inspected/i.test(candidate.reason),
    )
  ) {
    limitations.push("at least one form candidate could not be inspected");
  }
  if ((debug?.aiActions ?? []).some((action) => action.result === "failed")) {
    limitations.push("a bounded Stagehand discovery action failed");
  }
  if (
    !discoveryResult.candidate &&
    (debug?.frames ?? []).some(
      (frame) => !frame.sameOrigin && FORM_PROVIDER_PATTERN.test(frame.url),
    )
  ) {
    limitations.push("a recognized cross-origin form embed could not be directly inspected");
  }
  const unique_limitations = [...new Set(limitations)];
  const coverage = unique_limitations.length > 0 ? "partial" : "complete";
  const indirect_form_evidence = evidence.filter((record) =>
    [
      "recognizedFormEmbed",
      "formLikeNetwork",
      "contactRevealControl",
      "rejectedForm",
    ].includes(record.kind),
  );
  const strongest_indirect = strongest_evidence(indirect_form_evidence);

  let assessment: FormDiscoveryOutcome["assessment"];
  let presence_strength: PresenceEvidenceStrength;
  if (discoveryResult.candidate) {
    assessment = "confirmed_form_present";
    presence_strength = "strong";
  } else if (strongest_indirect === "strong") {
    assessment = "strong_form_evidence";
    presence_strength = "strong";
  } else if (strongest_indirect === "moderate" || strongest_indirect === "weak") {
    assessment = "possible_form_evidence";
    presence_strength = strongest_indirect;
  } else if (pageSignals.contactChannels.length > 0 && coverage === "complete") {
    assessment = "contact_channel_without_form";
    presence_strength = "none";
  } else if (coverage === "partial") {
    assessment = "no_form_observed_after_limited_search";
    presence_strength = "none";
  } else {
    assessment = "no_form_observed_after_complete_search";
    presence_strength = "none";
  }

  return {
    websiteUrl,
    assessment,
    contactFormFound: assessment === "confirmed_form_present",
    presenceEvidenceStrength: presence_strength,
    searchCoverage: coverage,
    description: discovery_description(
      assessment,
      discoveryResult.reason,
      discoveryResult.candidate?.frame.url() || finalUrl,
    ),
    assessedAt: options.assessedAt ?? new Date().toISOString(),
    ...(discoveryResult.contactPageFound ? { contactPageUrl: safe_url(finalUrl) } : {}),
    ...(discoveryResult.candidate
      ? { formFrameUrl: safe_url(discoveryResult.candidate.frame.url() || finalUrl) }
      : {}),
    evidence: deduplicate_evidence(evidence),
    rejectedCandidates: rejected_candidates,
    limitations: unique_limitations,
    ...(debug ? { discoveryDebug: debug } : {}),
  };
}

export function create_blocked_discovery_outcome(
  website_url: string,
  description: string,
): FormDiscoveryOutcome {
  return {
    websiteUrl: website_url,
    assessment: "site_inspection_blocked",
    contactFormFound: false,
    presenceEvidenceStrength: "none",
    searchCoverage: "blocked",
    description,
    assessedAt: new Date().toISOString(),
    evidence: [
      {
        kind: "inspectionLimitation",
        strength: "weak",
        description,
      },
    ],
    rejectedCandidates: [],
    limitations: [description],
  };
}

function network_form_evidence(
  records: NetworkDebugRecord[],
  signals: DiscoveryPageSignals,
  interactions: Array<{ performedAt: string }>,
): DiscoveryEvidenceRecord[] {
  const evidence: DiscoveryEvidenceRecord[] = [];
  for (const record of records) {
    const searchable = `${record.url} ${record.postDataPreview ?? ""}`;
    if (ANALYTICS_PATTERN.test(searchable)) continue;
    const provider = FORM_PROVIDER_PATTERN.test(searchable);
    const form_like = provider || FORM_RESOURCE_PATTERN.test(searchable);
    const status = record.status;
    const successful = status !== undefined && status >= 200 && status < 400;
    const semantic_data_request = ["xhr", "fetch"].includes(record.resourceType);
    if (!form_like || !successful || (!provider && !semantic_data_request)) continue;
    const request_started_at = Date.parse(record.startedAt);
    const correlated = interactions.some((interaction) => {
      const interaction_started_at = Date.parse(interaction.performedAt);
      return (
        !Number.isNaN(request_started_at) &&
        !Number.isNaN(interaction_started_at) &&
        request_started_at >= interaction_started_at &&
        request_started_at <= interaction_started_at + 30_000
      );
    });

    let strength: DiscoveryEvidenceRecord["strength"] = "weak";
    if (
      signals.contactContext &&
      ((provider && (correlated || signals.recognizedFormEmbeds.length > 0)) ||
        (semantic_data_request && correlated))
    ) {
      strength = "strong";
    }
    else if (signals.contactContext || provider) strength = "moderate";
    evidence.push({
      kind: "formLikeNetwork",
      strength,
      description:
        strength === "strong"
          ? "successful recognized form-provider request appeared with independent contact context"
          : "successful form-like network request appeared but did not independently prove a form",
      url: safe_url(record.url),
      status: status as number,
    });
  }
  return evidence.slice(0, 10);
}

function strongest_evidence(
  records: DiscoveryEvidenceRecord[],
): Exclude<PresenceEvidenceStrength, "none"> | undefined {
  if (records.some((record) => record.strength === "strong")) return "strong";
  if (records.some((record) => record.strength === "moderate")) return "moderate";
  if (records.some((record) => record.strength === "weak")) return "weak";
  return undefined;
}

function discovery_description(
  assessment: FormDiscoveryOutcome["assessment"],
  original_reason: string | undefined,
  form_url: string,
): string {
  switch (assessment) {
    case "confirmed_form_present":
      return `Validated contact form found at ${safe_url(form_url)}.`;
    case "strong_form_evidence":
      return "Strong independent evidence indicates a contact form exists, but its controls were not directly validated.";
    case "possible_form_evidence":
      return "Contact-form indicators were observed, but the evidence was not strong enough to confirm a form.";
    case "contact_channel_without_form":
      return "A contact channel was found, but bounded inspection observed no qualifying contact form.";
    case "no_form_observed_after_limited_search":
      return `No qualifying contact form was observed during an incomplete search${original_reason ? `: ${original_reason}` : "."}`;
    default:
      return `No qualifying contact form was observed after all bounded discovery checks completed${original_reason ? `: ${original_reason}` : "."}`;
  }
}

function deduplicate_evidence(
  records: DiscoveryEvidenceRecord[],
): DiscoveryEvidenceRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.kind}|${record.description}|${record.url ?? ""}|${record.status ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function is_contact_channel(
  value: string,
): value is DiscoveryPageSignals["contactChannels"][number] {
  return ["email", "telephone", "chat", "support", "externalBooking"].includes(value);
}

function format_channel(
  value: DiscoveryPageSignals["contactChannels"][number],
): string {
  return value === "externalBooking" ? "external booking" : value;
}

function safe_url(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return value.slice(0, 500);
  }
}
