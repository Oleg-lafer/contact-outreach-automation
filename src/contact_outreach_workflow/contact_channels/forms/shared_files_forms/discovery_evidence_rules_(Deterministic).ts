import type {
  DiscoveryDiagnosticDisposition,
  DiscoveryEvidenceRecord,
  DiscoveryNetworkClassification,
  DiscoveryPageSignals,
  DiscoveryProviderResource,
  DiscoveryProviderResourceRole,
  FormDiscoveryOutcome,
  NetworkDebugRecord,
  PresenceEvidenceStrength,
} from "./forms_types_(Support).js";

export const DISCOVERY_EVIDENCE_RULEBOOK_VERSION = "2.0.0";
export const DISCOVERY_ROUTE_ELIGIBILITY_SCORE = 11;

const PROVIDER_PATTERN =
  /hubspot|hsforms|marketo|mktoresp|pardot|salesforce|force\.com|jotform|typeform|formstack|wufoo|gravityforms|gravity_form|contact-form-7|wpcf7|calendly|cal\.com/i;

const TELEMETRY_HOST_PATTERN =
  /(^|\.)(?:google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com|facebook\.com|reddit\.com|linkedin\.com|ads\.linkedin\.com|pinterest\.com|yandex\.(?:com|ru)|hotjar\.com|clarity\.ms|fullstory\.com|mixpanel\.com|amplitude\.com|segment\.(?:com|io)|sentry\.io|stackadapt\.com|sharethis\.com|pingdom\.(?:com|net)|youtube\.com|youtube-nocookie\.com|vimeo\.com|newrelic\.com|nr-data\.net|datadoghq\.com)$/i;

const TELEMETRY_PATH_PATTERN =
  /^\/(?:youtubei\/v1\/log_event|api\/stats|stats\/|pixel|tr\/?$|collect(?:\/|$)|g\/collect|analytics(?:\/|$)|events?(?:\/|$)|track(?:ing)?(?:\/|$)|pagead(?:\/|$)|rmkt\/collect|ccm\/form-data|pagead\/form-data|consent(?:\/|$)|cookie(?:\/|$)|cookies(?:\/|$)|performance(?:\/|$)|beacon(?:\/|$)|challenge-platform(?:\/|$)|cdn-cgi\/challenge-platform)/i;

const CONSENT_OR_CHALLENGE_PATTERN =
  /cookiebot|cookieyes|onetrust|usercentrics|trustarc|quantcast|civiccomputing|consent|cmp|cloudflare|turnstile|recaptcha|hcaptcha|arkoselabs|challenge/i;

const FORM_ENDPOINT_PATTERN =
  /(?:\/submissions?\b|\/leadcapture\/save\b|\/forms?\/v\d+\/submissions?\b|\/forms?\/ajax\b|\/wp-json\/contact-form-7\/v\d+\/contact-forms\/[^/]+\/feedback\b|\/admin-ajax\.php\b|\/form_response\b|\/form-submit\b|\/webtolead\b)/i;

const STRICT_FORM_FRAME_PATTERN =
  /(?:^|\.)(?:forms(?:-[a-z0-9]+)?\.hsforms\.com|share\.hsforms\.com|form\.typeform\.com|typeform\.com|form\.jotform\.com|jotform\.com|formstack\.com|wufoo\.com)$/i;

const CHAT_PATTERN =
  /intercom|livechat|live-agent|liveagent|conversations|chat-widget|chatflow|tawk\.to|crisp\.chat|messenger/i;

const BOOKING_PATTERN = /calendly|cal\.com|acuityscheduling|appointment|booking|schedule/i;

export interface ClassifiedDiscoveryNetworkRecord {
  classification: DiscoveryNetworkClassification;
  provider: string;
  ruleId: string;
  ignoredReason?: string;
}

export interface DiscoveryEvidenceDecision {
  assessment: FormDiscoveryOutcome["assessment"];
  presenceEvidenceStrength: PresenceEvidenceStrength;
  disposition: DiscoveryDiagnosticDisposition;
  ruleId: string;
}

const parsedUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const providerName = (value: string): string => {
  const normalized = value.toLowerCase();
  if (/hubspot|hsforms/.test(normalized)) return "hubspot";
  if (/marketo|mktoresp/.test(normalized)) return "marketo";
  if (/pardot/.test(normalized)) return "pardot";
  if (/salesforce|force\.com/.test(normalized)) return "salesforce";
  if (/jotform/.test(normalized)) return "jotform";
  if (/typeform/.test(normalized)) return "typeform";
  if (/formstack/.test(normalized)) return "formstack";
  if (/wufoo/.test(normalized)) return "wufoo";
  if (/gravityforms|gravity_form/.test(normalized)) return "gravityforms";
  if (/contact-form-7|wpcf7/.test(normalized)) return "contact-form-7";
  if (/calendly/.test(normalized)) return "calendly";
  if (/cal\.com/.test(normalized)) return "cal.com";
  return "";
};

export function classify_discovery_network_record(
  record: Pick<NetworkDebugRecord, "url" | "postDataPreview" | "resourceType" | "method">,
): ClassifiedDiscoveryNetworkRecord {
  const url = parsedUrl(record.url);
  const host = url?.hostname.toLowerCase() ?? "";
  const pathname = url?.pathname.toLowerCase() ?? "";
  const searchable = `${record.url} ${record.postDataPreview ?? ""}`.toLowerCase();
  const provider = providerName(searchable);

  if (
    TELEMETRY_HOST_PATTERN.test(host) ||
    TELEMETRY_PATH_PATTERN.test(pathname) ||
    CONSENT_OR_CHALLENGE_PATTERN.test(searchable) ||
    /log_event|conversion|remarketing|pageview|page_view|telemetry|analytics|tracking|pixel|beacon/.test(searchable)
  ) {
    return {
      classification: "unrelated_telemetry",
      provider,
      ruleId: "DISCOVERY-NETWORK-IGNORED-TELEMETRY",
      ignoredReason: "analytics, advertising, consent, monitoring, video, or challenge traffic",
    };
  }

  const semantic_request = ["xhr", "fetch"].includes(record.resourceType.toLowerCase());
  const form_method = ["POST", "PUT", "PATCH"].includes(record.method.toUpperCase());
  if (
    FORM_ENDPOINT_PATTERN.test(`${pathname} ${searchable}`) &&
    (semantic_request || form_method)
  ) {
    return {
      classification: "confirmed_form_endpoint",
      provider,
      ruleId: provider
        ? "DISCOVERY-NETWORK-CONFIRMED-PROVIDER-ENDPOINT"
        : "DISCOVERY-NETWORK-CONFIRMED-FORM-ENDPOINT",
    };
  }

  if (provider || PROVIDER_PATTERN.test(searchable)) {
    return {
      classification: "provider_resource",
      provider,
      ruleId: "DISCOVERY-NETWORK-GENERIC-PROVIDER-RESOURCE",
      ignoredReason: "generic provider traffic does not prove that a usable form is present",
    };
  }

  return {
    classification: "unknown",
    provider: "",
    ruleId: "DISCOVERY-NETWORK-UNKNOWN",
    ignoredReason: "the request is not independently attributable to a contact form",
  };
}

export function classify_discovery_provider_resource(
  rawUrl: string,
  source: DiscoveryProviderResource["source"],
  visible: boolean,
): DiscoveryProviderResource {
  const url = parsedUrl(rawUrl);
  const host = url?.hostname.toLowerCase() ?? "";
  const searchable = rawUrl.toLowerCase();
  const provider = providerName(searchable);
  let role: DiscoveryProviderResourceRole = "unknown_provider_resource";

  if (source !== "script" && BOOKING_PATTERN.test(searchable)) role = "booking_frame";
  else if (source !== "script" && CHAT_PATTERN.test(searchable)) role = "chat_frame";
  else if (
    source !== "script" &&
    visible &&
    (STRICT_FORM_FRAME_PATTERN.test(host) || /\/forms?\/|\/to\//i.test(url?.pathname ?? ""))
  ) role = "form_frame";
  else if (source === "script" && /analytics|tracking|munchkin|visitor|chat|conversations/i.test(searchable)) {
    role = "analytics_script";
  } else if (source === "script" || provider) role = "provider_script";

  return { url: rawUrl, provider, role, source, visible };
}

export const genuine_form_provider_frames = (
  signals: DiscoveryPageSignals,
): DiscoveryProviderResource[] =>
  (signals.providerResources ?? []).filter((resource) => resource.role === "form_frame" && resource.visible);

export const is_genuine_form_provider_frame = (url: string): boolean =>
  classify_discovery_provider_resource(url, "frame", true).role === "form_frame";

const evidenceStrength = (
  records: DiscoveryEvidenceRecord[],
): PresenceEvidenceStrength => {
  if (records.some((record) => record.strength === "strong")) return "strong";
  if (records.some((record) => record.strength === "moderate")) return "moderate";
  if (records.some((record) => record.strength === "weak")) return "weak";
  return "none";
};

export function evaluate_discovery_evidence(input: {
  candidateFound: boolean;
  contactChannelObserved: boolean;
  coverageComplete: boolean;
  evidence: DiscoveryEvidenceRecord[];
}): DiscoveryEvidenceDecision {
  if (input.candidateFound) {
    return {
      assessment: "confirmed_form_present",
      presenceEvidenceStrength: "strong",
      disposition: "confirmed_usable_form",
      ruleId: "DISCOVERY-EVIDENCE-CONFIRMED-FORM",
    };
  }

  const structural = input.evidence.filter((record) =>
    record.kind === "recognizedFormEmbed" ||
    record.kind === "rejectedForm" ||
    (record.kind === "contactRevealControl" && record.strength !== "weak"),
  );
  const credible_network = input.evidence.filter((record) =>
    record.kind === "formLikeNetwork" &&
    record.networkClassification === "confirmed_form_endpoint",
  );
  const structural_strength = evidenceStrength(structural);
  const has_independent_support = credible_network.length > 0 ||
    structural.filter((record) => record.kind !== structural[0]?.kind).length > 0;

  if (structural.length > 0) {
    const strong = ["strong", "moderate"].includes(structural_strength) && has_independent_support;
    return {
      assessment: strong ? "strong_form_evidence" : "possible_form_evidence",
      presenceEvidenceStrength: strong ? "strong" : structural_strength === "none" ? "weak" : structural_strength,
      disposition: strong ? "probable_missed_form" : "possible_missed_form",
      ruleId: strong
        ? "DISCOVERY-EVIDENCE-STRONG-STRUCTURAL"
        : "DISCOVERY-EVIDENCE-POSSIBLE-STRUCTURAL",
    };
  }

  if (!input.coverageComplete) {
    return {
      assessment: "no_form_observed_after_limited_search",
      presenceEvidenceStrength: "none",
      disposition: "inspection_incomplete",
      ruleId: "DISCOVERY-EVIDENCE-INCOMPLETE",
    };
  }

  if (input.contactChannelObserved) {
    return {
      assessment: "contact_channel_without_form",
      presenceEvidenceStrength: "none",
      disposition: "complete_no_usable_form_observed",
      ruleId: "DISCOVERY-EVIDENCE-CHANNEL-NO-FORM",
    };
  }

  return {
    assessment: "no_form_observed_after_complete_search",
    presenceEvidenceStrength: "none",
    disposition: "complete_no_usable_form_observed",
    ruleId: "DISCOVERY-EVIDENCE-COMPLETE-NO-FORM",
  };
}
