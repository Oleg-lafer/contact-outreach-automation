import type { Page } from "playwright";
import { has_contact_route_intent } from "../../../../orchestrator/C_contact_routes/C2_contact_route_scoring_(Deterministic).js";
import type {
  FormDiscoveryResult,
  DiscoveryEvidenceRecord,
  FormDiscoveryOutcome,
  DiscoveryPageSignals,
  NetworkDebugRecord,
  PresenceEvidenceStrength,
  DiscoveryInspectionAttemptDebug,
  DiscoveryNetworkEvidenceDebug,
  DiscoveryProviderResource,
  DiscoveryFormCandidateDebug,
} from "../../shared_files_forms/forms_types_(Support).js";
import {
  classify_discovery_network_record,
  classify_discovery_provider_resource,
  DISCOVERY_EVIDENCE_RULEBOOK_VERSION,
  evaluate_discovery_evidence,
  genuine_form_provider_frames,
  is_genuine_form_provider_frame,
} from "../../shared_files_forms/discovery_evidence_rules_(Deterministic).js";

const FORM_RESOURCE_PATTERN =
  /contact|inquir|enquir|lead|form|quote|consult|booking|book-a-call|request|message|submit|submission|צור.?קשר|טופס|הצעת.?מחיר|ייעוץ|פגישה|פנייה|פניה|הודעה|שליחה/iu;

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

      const is_visible = [(element: Element): boolean => {
        const view = element.ownerDocument.defaultView;
        if (!view) return false;
        try {
          const style = view.getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
        } catch {
          return false;
        }
      }][0]!;
      const resources = Array.from(
        document.querySelectorAll("iframe[src], script[src]"),
      )
        .map((element) => ({
          url: element.getAttribute("src") ?? "",
          source: element.tagName.toLowerCase() === "iframe" ? "iframe" : "script",
          visible: element.tagName.toLowerCase() === "iframe" ? is_visible(element) : false,
        }))
        .filter((resource) => Boolean(resource.url));
      const controls = Array.from(
        document.querySelectorAll("button, [role='button'], a:not([href])"),
      )
        .filter((element) => {
          return (
            !element.closest("form") &&
            is_visible(element)
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
          /contact|get in touch|inquir|enquir|consult|book|schedule|quote|proposal|start.*project|work with us|audit|talk to us|צור קשר|צרו קשר|דברו איתנו|פנו אלינו|השאירו פרטים|הצעת מחיר|ייעוץ|קבעו פגישה|תיאום פגישה/iu.test(
            label,
          ),
        )
        .slice(0, 10);
      return { bodyContext: body_context, channels, resources, controls };
    });

  const dom_resources = page_signals.resources.map((resource) =>
    classify_discovery_provider_resource(
      safe_url(resource.url),
      resource.source as "iframe" | "script",
      resource.visible,
    ),
  );
  const dom_frame_urls = new Set(
    dom_resources.filter((resource) => resource.source === "iframe").map((resource) => safe_url(resource.url)),
  );
  const frame_resources = page.frames().map((frame) => safe_url(frame.url())).filter(Boolean)
    .filter((url) => !dom_frame_urls.has(url))
    .map((url) => classify_discovery_provider_resource(url, "frame", true));
  const provider_resources = deduplicate_provider_resources([...dom_resources, ...frame_resources]);
  const recognized_embeds = provider_resources
    .filter((resource) => resource.role === "form_frame" && resource.visible)
    .map((resource) => resource.url);
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
    providerResources: provider_resources,
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
  const inspection_signals = debug?.inspectionAttempts?.length
    ? debug.inspectionAttempts.map((inspection) => ({
        inspectionId: inspection.inspectionId,
        signals: inspection.pageSignals,
      }))
    : [{ inspectionId: undefined, signals: pageSignals }];
  const all_page_signals = merge_page_signals(inspection_signals.map((entry) => entry.signals));

  if (discoveryResult.candidate) {
    evidence.push({
      kind: "validatedContactForm",
      strength: "strong",
      description: `Playwright validated a ${discoveryResult.candidate.classification ?? "contact"} form candidate`,
      url: safe_url(discoveryResult.candidate.frame.url() || finalUrl),
    });
  }
  for (const entry of inspection_signals) {
    for (const resource of entry.signals.providerResources ?? []) {
      if (resource.role === "form_frame" && resource.visible) {
        evidence.push({
          ...(entry.inspectionId ? { inspectionId: entry.inspectionId } : {}),
          kind: "recognizedFormEmbed",
          strength: "moderate",
          description: "visible recognized form-provider frame could not be validated as a usable form",
          url: resource.url,
          provider: resource.provider,
          providerRole: resource.role,
        });
      } else if (resource.provider || resource.role !== "unknown_provider_resource") {
        evidence.push({
          ...(entry.inspectionId ? { inspectionId: entry.inspectionId } : {}),
          kind: "providerResource",
          strength: "weak",
          description: `observed ${resource.role.replaceAll("_", " ")}; this does not prove that a usable form exists`,
          url: resource.url,
          provider: resource.provider,
          providerRole: resource.role,
          ignoredReason: "generic provider, chat, booking, or analytics resources are not form-presence evidence",
        });
      }
    }
  }
  const network_result = network_form_evidence(
    networkRecords,
    debug?.inspectionAttempts ?? [],
    debug?.candidates ?? [],
    debug?.interactions ?? [],
  );
  evidence.push(...network_result.evidence);

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
  for (const control of all_page_signals.contactRevealControls) {
    const changed = (debug?.interactions ?? []).some((interaction) =>
      interaction.pageStateChanged && interaction.label === control,
    );
    evidence.push({
      kind: "contactRevealControl",
      strength: changed ? "moderate" : "weak",
      description: `visible contact-oriented reveal control: ${control}`,
    });
  }
  for (const channel of all_page_signals.contactChannels) {
    evidence.push({
      kind: "contactChannel",
      strength: "weak",
      description: `contact channel observed: ${format_channel(channel)}`,
    });
  }
  for (const candidate of rejected_candidates) {
    if (credible_rejected_candidate(candidate)) {
      evidence.push({
        ...(candidate.inspectionId ? { inspectionId: candidate.inspectionId } : {}),
        kind: "rejectedForm",
        strength: candidate.signals.hasMessage && candidate.signals.hasEmail ? "moderate" : "weak",
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
      (frame) => !frame.sameOrigin && is_genuine_form_provider_frame(frame.url),
    )
  ) {
    limitations.push("a recognized cross-origin form embed could not be directly inspected");
  }
  const unique_limitations = [...new Set(limitations)];
  const base_coverage_complete = debug?.coverageAssessment
    ? debug.coverageAssessment.completeEnoughForNoFormConclusion
    : unique_limitations.length === 0;
  const coverage_complete = base_coverage_complete && unique_limitations.length === 0;
  const coverage = coverage_complete ? "complete" : "partial";
  const decision = evaluate_discovery_evidence({
    candidateFound: Boolean(discoveryResult.candidate),
    contactChannelObserved: all_page_signals.contactChannels.length > 0,
    coverageComplete: coverage_complete,
    evidence,
  });
  const assessment = decision.assessment;
  const presence_strength = decision.presenceEvidenceStrength;

  evidence.forEach((record, index) => {
    record.evidenceId = `evidence-${index + 1}`;
    if (!record.inspectionId && record.url && debug?.inspectionAttempts) {
      const inspection_id = debug.inspectionAttempts.find(
        (inspection) => safe_url(inspection.finalUrl) === safe_url(record.url ?? ""),
      )?.inspectionId;
      if (inspection_id) record.inspectionId = inspection_id;
    }
  });
  if (debug) {
    debug.evidence = deduplicate_evidence(evidence);
    debug.limitations = unique_limitations;
    debug.strongestEvidence = strongest_evidence(evidence) ?? "none";
    debug.assessmentRuleId = decision.ruleId;
    debug.evidenceRulebookVersion = DISCOVERY_EVIDENCE_RULEBOOK_VERSION;
    debug.assessmentExplanation = discovery_description(
      assessment,
      discoveryResult.reason,
      discoveryResult.candidate?.frame.url() || finalUrl,
    );
    debug.evidenceNetworkRecords = network_result.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      evidenceId: debug.evidence?.find((record) =>
        record.kind === "formLikeNetwork" && safe_url(record.url ?? "") === safe_url(diagnostic.url),
      )?.evidenceId ?? "",
    })).slice(
      0,
      debug.limits?.maxEvidenceNetworkRecords ?? 10,
    );
    if (debug.limits) {
      debug.limits.omittedEvidenceNetworkRecords = Math.max(
        0,
        network_result.diagnostics.length - debug.evidenceNetworkRecords.length,
      );
    }
    if (debug.coverageAssessment) {
      debug.coverageAssessment.incompleteReasons = [
        ...new Set([...debug.coverageAssessment.incompleteReasons, ...unique_limitations]),
      ];
      debug.coverageAssessment.inspectionIncompleteReasons = [
        ...new Set([
          ...(debug.coverageAssessment.inspectionIncompleteReasons ?? debug.coverageAssessment.incompleteReasons),
          ...unique_limitations,
        ]),
      ];
      debug.coverageAssessment.incompleteReasons = debug.coverageAssessment.inspectionIncompleteReasons;
      debug.coverageAssessment.completeEnoughForNoFormConclusion = !discoveryResult.candidate &&
        debug.coverageAssessment.incompleteReasons.length === 0 &&
        (debug.coverageAssessment.eligibleRoutesSkipped ?? 0) === 0;
    }
    debug.diagnosticDisposition = decision.disposition;
    for (const record of debug.evidence) {
      const inspection = debug.inspectionAttempts?.find((item) => item.inspectionId === record.inspectionId);
      if (inspection && record.evidenceId && !inspection.evidenceIds.includes(record.evidenceId)) {
        inspection.evidenceIds.push(record.evidenceId);
      }
    }
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

function assessment_rule_id(assessment: FormDiscoveryOutcome["assessment"]): string {
  switch (assessment) {
    case "confirmed_form_present": return "DISCOVERY-EVIDENCE-CONFIRMED-FORM";
    case "strong_form_evidence": return "DISCOVERY-EVIDENCE-STRONG-INDIRECT";
    case "possible_form_evidence": return "DISCOVERY-EVIDENCE-POSSIBLE-INDIRECT";
    case "contact_channel_without_form": return "DISCOVERY-EVIDENCE-CHANNEL-NO-FORM";
    case "no_form_observed_after_limited_search": return "DISCOVERY-EVIDENCE-INCOMPLETE";
    case "site_inspection_blocked": return "DISCOVERY-EVIDENCE-BLOCKED";
    default: return "DISCOVERY-EVIDENCE-COMPLETE-NO-FORM";
  }
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
  inspections: DiscoveryInspectionAttemptDebug[],
  candidates: DiscoveryFormCandidateDebug[],
  interactions: Array<{ performedAt: string; pageStateChanged?: boolean }>,
): { evidence: DiscoveryEvidenceRecord[]; diagnostics: DiscoveryNetworkEvidenceDebug[] } {
  const evidence: DiscoveryEvidenceRecord[] = [];
  const diagnostics: DiscoveryNetworkEvidenceDebug[] = [];
  for (const record of records) {
    if (record.status === undefined) continue;
    const classified = classify_discovery_network_record(record);
    const legacy_semantic_match = FORM_RESOURCE_PATTERN.test(`${record.url} ${record.postDataPreview ?? ""}`);
    if (classified.classification === "unknown" && !legacy_semantic_match) continue;
    const inspection = inspection_for_network_record(record, inspections);
    // An unscoped request must stay network-only. Never lend it structural
    // evidence from whichever page happened to be final.
    const signals = inspection?.pageSignals ?? {
      contactContext: false,
      contactChannels: [],
      recognizedFormEmbeds: [],
      providerResources: [],
      contactRevealControls: [],
    };
    const request_started_at = Date.parse(record.startedAt);
    const correlated = interactions.some((interaction) => {
      const interaction_started_at = Date.parse(interaction.performedAt);
      return interaction.pageStateChanged === true &&
        !Number.isNaN(request_started_at) &&
        !Number.isNaN(interaction_started_at) &&
        request_started_at >= interaction_started_at &&
        request_started_at <= interaction_started_at + 30_000;
    });
    const structural = genuine_form_provider_frames(signals).length > 0 || candidates.some((candidate) =>
      candidate.inspectionId === inspection?.inspectionId &&
      (candidate.accepted || credible_rejected_candidate(candidate)),
    );
    const successful = record.status >= 200 && record.status < 400;
    const credible = classified.classification === "confirmed_form_endpoint" && successful && structural;
    const rule_id = classified.classification === "unknown" && legacy_semantic_match
      ? "DISCOVERY-NETWORK-IGNORED-SEMANTIC-ONLY"
      : classified.ruleId;
    const ignored_reason = credible
      ? undefined
      : classified.ignoredReason ?? "network-only evidence has no independent structural form signal";

    if (credible) {
      evidence.push({
        ...(inspection ? { inspectionId: inspection.inspectionId } : {}),
        kind: "formLikeNetwork",
        strength: correlated && signals.contactContext ? "strong" : "moderate",
        description: "a form-specific endpoint appeared with independent structural form evidence",
        url: safe_url(record.url),
        status: record.status,
        provider: classified.provider,
        networkClassification: classified.classification,
      });
    }
    diagnostics.push({
      evidenceId: "",
      ...(inspection ? { inspectionId: inspection.inspectionId } : {}),
      url: safe_url(record.url),
      resourceType: record.resourceType,
      status: record.status,
      providerMatched: Boolean(classified.provider),
      correlationReason: credible
        ? "request was scoped to an inspection with independent structural form evidence"
        : "request was retained for audit but did not independently establish form presence",
      strength: credible ? (correlated && signals.contactContext ? "strong" : "moderate") : "weak",
      ruleId: rule_id,
      classification: classified.classification,
      ...(classified.provider ? { provider: classified.provider } : {}),
      ...(ignored_reason ? { ignoredReason: ignored_reason } : {}),
    });
  }
  return { evidence: deduplicate_evidence(evidence), diagnostics };
}

function inspection_for_network_record(
  record: NetworkDebugRecord,
  inspections: DiscoveryInspectionAttemptDebug[],
): DiscoveryInspectionAttemptDebug | undefined {
  const by_id = inspections.find((inspection) =>
    inspection.networkRecordStartId !== undefined &&
    inspection.networkRecordEndId !== undefined &&
    record.id >= inspection.networkRecordStartId &&
    record.id <= inspection.networkRecordEndId,
  );
  if (by_id) return by_id;
  return inspections.find((inspection) =>
    record.startedAt >= inspection.readiness.startedAt && record.startedAt <= inspection.readiness.finishedAt,
  );
}

function credible_rejected_candidate(candidate: DiscoveryFormCandidateDebug): boolean {
  return !candidate.signals.hasNegativeContext &&
    candidate.signals.hasMessage &&
    (candidate.signals.hasEmail || candidate.signals.hasPhone || candidate.signals.hasContactContext) &&
    /could not be inspected|no visible submit|no visible email|sufficient contact shape|message field/i.test(
      candidate.reason,
    );
}

function merge_page_signals(signals: DiscoveryPageSignals[]): DiscoveryPageSignals {
  return {
    contactContext: signals.some((entry) => entry.contactContext),
    contactChannels: [...new Set(signals.flatMap((entry) => entry.contactChannels))],
    recognizedFormEmbeds: [...new Set(signals.flatMap((entry) => entry.recognizedFormEmbeds))],
    providerResources: deduplicate_provider_resources(signals.flatMap((entry) => entry.providerResources ?? [])),
    contactRevealControls: [...new Set(signals.flatMap((entry) => entry.contactRevealControls))],
  };
}

function deduplicate_provider_resources(
  resources: DiscoveryProviderResource[],
): DiscoveryProviderResource[] {
  const seen = new Set<string>();
  return resources.filter((resource) => {
    const key = `${resource.source}|${resource.role}|${safe_url(resource.url)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
