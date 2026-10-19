import type {
  AnalyticsResult,
  CountAndSites,
  SiteClassification,
  StageState,
} from "./analytics_types.js";

type SignalStage = "browser" | "discovery";
type OutcomeBucketKey = "continued" | "external_stop" | "automation_not_ruled_out";

export interface CanonicalStageSignal {
  family: string;
  label: string;
  count: number;
  percentageOfEntrants: number;
  siteIds: string[];
}

export interface StageSignalOutcomeBucket {
  key: OutcomeBucketKey;
  title: string;
  count: number;
  percentageOfEntrants: number;
  siteIds: string[];
  signals: CanonicalStageSignal[];
}

export interface StageSignalDashboardSection {
  stage: SignalStage;
  title: string;
  entered: number;
  buckets: [StageSignalOutcomeBucket, StageSignalOutcomeBucket, StageSignalOutcomeBucket];
  reconciles: boolean;
}

export interface BrowserDiscoverySignalDashboardData {
  browser: StageSignalDashboardSection;
  discovery: StageSignalDashboardSection;
}

interface MutableSignal {
  family: string;
  label: string;
  siteIds: Set<string>;
}

const ENTRANT_STATES = new Set<StageState>([
  "entered",
  "advanced",
  "qualified_not_executed",
  "completed",
  "stopped",
  "incomplete",
]);

const FAMILY_ORDER = [
  "Primary outcome",
  "Browser outcome",
  "Responsibility classification",
  "Connectivity",
  "HTTP responses",
  "Security and transport",
  "Access restrictions",
  "Automation and unresolved loading",
  "Stop signal",
  "Diagnostic disposition",
  "Assessment rule",
  "Route outcome",
  "Page quality",
  "Candidate rule",
  "Incomplete evidence",
  "Contradiction",
  "Classification rule",
  "Supporting evidence",
] as const;

const familyRank = (family: string): number => {
  const index = FAMILY_ORDER.indexOf(family as (typeof FAMILY_ORDER)[number]);
  return index === -1 ? FAMILY_ORDER.length : index;
};

const percentage = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(2));

const humanizeIdentifier = (value: string): string => {
  const words = value
    .replace(/^(?:BRW|DSC|DISCOVERY)-(?:EVIDENCE-|CANDIDATE-|REJECT-)?/i, "")
    .replaceAll(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  const label = words ? words[0]!.toUpperCase() + words.slice(1) : "Unclassified signal";
  return label
    .replace(/\bhttp\b/gi, "HTTP")
    .replace(/\bdns\b/gi, "DNS")
    .replace(/\btls\b/gi, "TLS")
    .replace(/\b([1-5])xx\b/gi, (_, digit: string) => `${digit}XX`);
};

const browserStopFamily = (label: string): string => {
  if (/\b(?:dns|connection)\b/i.test(label)) return "Connectivity";
  if (/\bhttp\b/i.test(label)) return "HTTP responses";
  if (/\b(?:tls|certificate|insecure transport)\b/i.test(label)) return "Security and transport";
  if (/\b(?:access restriction|antibot|captcha)\b/i.test(label)) return "Access restrictions";
  if (/\b(?:automation|browser launch|timeout|crash|detachment|undetermined)\b/i.test(label)) {
    return "Automation and unresolved loading";
  }
  if (/\b(?:empty page|error page|parked domain|unusable page)\b/i.test(label)) return "Page quality";
  return "Stop signal";
};

const bucketForSite = (site: SiteClassification, stage: SignalStage): OutcomeBucketKey | undefined => {
  const state = site.stageStates[stage];
  if (!ENTRANT_STATES.has(state)) return undefined;
  if (["advanced", "qualified_not_executed", "completed"].includes(state)) return "continued";
  if (state === "stopped" && site.attribution === "non_workflow_attributable") return "external_stop";
  return "automation_not_ruled_out";
};

const newSignalMaps = (): Record<OutcomeBucketKey, Map<string, MutableSignal>> => ({
  continued: new Map(),
  external_stop: new Map(),
  automation_not_ruled_out: new Map(),
});

const addSignal = (
  maps: Record<OutcomeBucketKey, Map<string, MutableSignal>>,
  bucket: OutcomeBucketKey,
  family: string,
  label: string,
  siteId: string,
): void => {
  const normalizedLabel = label.trim();
  if (!normalizedLabel) return;
  const key = `${family}\u0000${normalizedLabel}`;
  const existing = maps[bucket].get(key) ?? { family, label: normalizedLabel, siteIds: new Set<string>() };
  existing.siteIds.add(siteId);
  maps[bucket].set(key, existing);
};

const finalizeSignals = (
  signals: Map<string, MutableSignal>,
  entered: number,
): CanonicalStageSignal[] => [...signals.values()]
  .map((signal) => ({
    family: signal.family,
    label: signal.label,
    count: signal.siteIds.size,
    percentageOfEntrants: percentage(signal.siteIds.size, entered),
    siteIds: [...signal.siteIds].sort(),
  }))
  .filter((signal) => signal.count > 0)
  .sort((left, right) =>
    familyRank(left.family) - familyRank(right.family) ||
    right.count - left.count ||
    left.label.localeCompare(right.label)
  );

const buildSection = (
  stage: SignalStage,
  title: string,
  sites: SiteClassification[],
  signalMaps: Record<OutcomeBucketKey, Map<string, MutableSignal>>,
): StageSignalDashboardSection => {
  const entrants = sites.filter((site) => bucketForSite(site, stage));
  const bucketSites = (key: OutcomeBucketKey): SiteClassification[] =>
    entrants.filter((site) => bucketForSite(site, stage) === key);
  const makeBucket = (key: OutcomeBucketKey, bucketTitle: string): StageSignalOutcomeBucket => {
    const matching = bucketSites(key);
    return {
      key,
      title: bucketTitle,
      count: matching.length,
      percentageOfEntrants: percentage(matching.length, entrants.length),
      siteIds: matching.map((site) => site.id).sort(),
      signals: finalizeSignals(signalMaps[key], entrants.length),
    };
  };
  const buckets = [
    makeBucket("continued", `${title} continued`),
    makeBucket(
      "external_stop",
      stage === "browser" ? "Destination-related stop" : "No suitable form available",
    ),
    makeBucket("automation_not_ruled_out", "Automation involvement cannot be ruled out"),
  ] as StageSignalDashboardSection["buckets"];
  return {
    stage,
    title: `${title} stage`,
    entered: entrants.length,
    buckets,
    reconciles: buckets.reduce((sum, bucket) => sum + bucket.count, 0) === entrants.length,
  };
};

const browserOutcomeLabel = (site: SiteClassification): string => {
  if (site.browserStage?.outcome === "LOADED_AFTER_TIMEOUT") return "Page loaded after a navigation timeout";
  if (site.browserStage?.outcome === "LOADED") return "Page loaded normally";
  if (site.browserStage?.outcome === "FAILED") return "Browser stage stopped";
  if (site.stageStates.browser === "incomplete") return "Incomplete or missing terminal evidence";
  return "Browser outcome inferred from legacy evidence";
};

const buildBrowserSection = (result: AnalyticsResult): StageSignalDashboardSection => {
  const maps = newSignalMaps();
  for (const site of result.sites) {
    const bucket = bucketForSite(site, "browser");
    if (!bucket) continue;
    addSignal(maps, bucket, "Browser outcome", browserOutcomeLabel(site), site.id);
    const browser = site.browserStage;
    if (browser?.category) {
      addSignal(maps, bucket, "Responsibility classification", humanizeIdentifier(browser.category), site.id);
    }
    const subcategory = browser?.subcategory || (
      site.terminalStage === "browser" ? site.subcategory : ""
    );
    if (subcategory) {
      const label = humanizeIdentifier(subcategory);
      addSignal(maps, bucket, browserStopFamily(label), label, site.id);
    }
    const ruleId = browser?.ruleId || (site.terminalStage === "browser" ? site.ruleId : "");
    if (ruleId) addSignal(maps, bucket, "Classification rule", humanizeIdentifier(ruleId), site.id);
    if (browser?.pageQuality) {
      addSignal(maps, bucket, "Page quality", humanizeIdentifier(browser.pageQuality), site.id);
    }
    if (browser?.mainDocumentReceived === true) {
      addSignal(maps, bucket, "Supporting evidence", "Main document received", site.id);
    }
    if (browser?.meaningfulContent === true) {
      addSignal(maps, bucket, "Supporting evidence", "Meaningful page content observed", site.id);
    }
    if (browser?.recoveryEligible) {
      addSignal(maps, bucket, "Supporting evidence", "Navigation recovery was eligible", site.id);
    }
    if (browser?.recovered) {
      addSignal(maps, bucket, "Supporting evidence", "Navigation recovered successfully", site.id);
    }
  }
  return buildSection("browser", "Browser", result.sites, maps);
};

const DISCOVERY_LABELS: Record<string, string> = {
  confirmed_usable_form: "Confirmed usable form",
  probable_missed_form: "Probable missed form",
  possible_missed_form: "Possible missed form",
  complete_no_usable_form_observed: "Complete inspection found no usable form",
  inspection_incomplete: "Discovery inspection incomplete",
  "DISCOVERY-EVIDENCE-CHANNEL-NO-FORM": "Contact channel found, but no suitable form",
  "DISCOVERY-EVIDENCE-COMPLETE-NO-FORM": "Complete inspection found no suitable form",
  "DISCOVERY-EVIDENCE-CONFIRMED-FORM": "Confirmed usable form evidence",
  "DISCOVERY-EVIDENCE-INCOMPLETE": "Incomplete discovery evidence",
  "DISCOVERY-EVIDENCE-POSSIBLE-INDIRECT": "Possible indirect form evidence",
  "DISCOVERY-EVIDENCE-STRONG-INDIRECT": "Strong indirect form evidence",
  duplicate: "Duplicate route",
  http_error: "Route returned an HTTP error",
  loaded: "Route loaded",
  navigation_failed: "Route navigation failed",
  redirected: "Route redirected",
  timed_out: "Route timed out",
  empty: "Empty page",
  error_page: "Error page",
  usable: "Usable page",
  "DISCOVERY-CANDIDATE-COMPLETE": "Complete contact-form candidate",
  "DISCOVERY-CANDIDATE-PROGRESSION": "Safe progression-form candidate",
  "DISCOVERY-REJECT-DIRECTIONS": "Directions form rejected",
  "DISCOVERY-REJECT-JOBS": "Jobs form rejected",
  "DISCOVERY-REJECT-NEWSLETTER": "Newsletter form rejected",
  "DISCOVERY-REJECT-NO-EMAIL": "Candidate rejected because no email field was found",
  "DISCOVERY-REJECT-NO-MESSAGE-CONTEXT": "Candidate rejected because message context was missing",
  "DISCOVERY-REJECT-NO-MESSAGE-PROGRESSION": "Progression candidate rejected because message input was missing",
  "DISCOVERY-REJECT-NO-SUBMIT": "Candidate rejected because no submit control was found",
  "DISCOVERY-REJECT-SEARCH-LOGIN": "Search or login form rejected",
  complete_search_with_incomplete_coverage: "Complete-search claim contradicted incomplete coverage",
  opened_route_with_http_error: "Opened route also recorded an HTTP error",
  submit_reported_with_zero_visible_controls: "Submit signal reported with no visible controls",
};

const discoveryLabel = (value: string): string => DISCOVERY_LABELS[value] ?? humanizeIdentifier(value);

const canonicalIncompleteReason = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (/^http_error\s*:/.test(normalized)) return "Route returned an HTTP error";
  if (/^timed_out\s*:/.test(normalized)) return "Route timed out";
  if (/^navigation_failed\s*:/.test(normalized)) return "Route navigation failed";
  if (/^contact destination could not be inspected\s*:/.test(normalized)) {
    return "Contact destination could not be inspected";
  }
  if (normalized.includes("cross-origin form embed")) return "Cross-origin form embed could not be inspected";
  if (normalized.includes("form candidate could not be inspected")) return "Form candidate could not be inspected";
  if (normalized.includes("candidate limit reached")) return "Candidate inspection limit reached";
  if (normalized.includes("contact route was inaccessible")) return "Contact route was inaccessible";
  if (/https?:\/\//i.test(value)) return "Other incomplete discovery evidence";
  return humanizeIdentifier(value);
};

const addDiscoveryGroups = (
  maps: Record<OutcomeBucketKey, Map<string, MutableSignal>>,
  bucketBySite: Map<string, OutcomeBucketKey>,
  family: string,
  groups: Record<string, CountAndSites>,
  labelForValue: (value: string) => string = discoveryLabel,
): void => {
  for (const [value, group] of Object.entries(groups)) {
    const label = labelForValue(value);
    for (const siteId of new Set(group.siteIds)) {
      const bucket = bucketBySite.get(siteId);
      if (bucket) addSignal(maps, bucket, family, label, siteId);
    }
  }
};

const buildDiscoverySection = (result: AnalyticsResult): StageSignalDashboardSection => {
  const maps = newSignalMaps();
  const bucketBySite = new Map<string, OutcomeBucketKey>();
  for (const site of result.sites) {
    const bucket = bucketForSite(site, "discovery");
    if (!bucket) continue;
    bucketBySite.set(site.id, bucket);
    const primary = site.discoveryAssessment
      ? discoveryLabel(site.discoveryAssessment)
      : site.stageStates.discovery === "incomplete"
        ? "Incomplete or missing terminal evidence"
        : bucket === "continued"
          ? "Discovery continued using legacy evidence"
          : humanizeIdentifier(site.subcategory);
    addSignal(maps, bucket, "Primary outcome", primary, site.id);
    if (site.terminalStage === "discovery" && site.ruleId) {
      addSignal(maps, bucket, "Classification rule", humanizeIdentifier(site.ruleId), site.id);
    }
  }

  const observability = result.discoveryObservability;
  addDiscoveryGroups(maps, bucketBySite, "Diagnostic disposition", observability.dispositions);
  addDiscoveryGroups(maps, bucketBySite, "Assessment rule", observability.assessmentRules);
  addDiscoveryGroups(maps, bucketBySite, "Route outcome", observability.routeOutcomes);
  addDiscoveryGroups(maps, bucketBySite, "Page quality", observability.pageQualities);
  addDiscoveryGroups(maps, bucketBySite, "Candidate rule", observability.candidateRules);
  addDiscoveryGroups(
    maps,
    bucketBySite,
    "Incomplete evidence",
    observability.incompleteReasons,
    canonicalIncompleteReason,
  );
  addDiscoveryGroups(maps, bucketBySite, "Contradiction", observability.contradictions);
  return buildSection("discovery", "Discovery", result.sites, maps);
};

export const buildBrowserDiscoverySignalDashboardData = (
  result: AnalyticsResult,
): BrowserDiscoverySignalDashboardData => ({
  browser: buildBrowserSection(result),
  discovery: buildDiscoverySection(result),
});

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

interface DashboardAttemptDetails {
  ruleId: string;
  reason: string;
  confidence: string;
  supportingEvidence: string;
  sourceArtifact: string;
}

interface DashboardAttempt {
  id: string;
  websiteUrl: string;
  browser: DashboardAttemptDetails;
  discovery: DashboardAttemptDetails;
}

interface BrowserDiscoveryDashboardData {
  generatedAt: string;
  runPath: string;
  sections: StageSignalDashboardSection[];
  attempts: Record<string, DashboardAttempt>;
}

const firstMatchingPath = (site: SiteClassification, pattern: RegExp): string =>
  site.sourcePaths.find((sourcePath) => pattern.test(sourcePath)) ?? site.sourcePaths[0] ?? "";

const buildDashboardAttempts = (result: AnalyticsResult): Record<string, DashboardAttempt> => {
  const discoveryBySite = new Map(
    result.discoveryObservability.sites.map((site) => [site.siteId, site] as const),
  );
  return Object.fromEntries(result.sites.map((site) => {
    const discovery = discoveryBySite.get(site.id);
    const browser = site.browserStage;
    return [site.id, {
      id: site.id,
      websiteUrl: site.websiteUrl,
      browser: {
        ruleId: browser?.ruleId || (site.terminalStage === "browser" ? site.ruleId : ""),
        reason: browser?.reason || (site.terminalStage === "browser" ? site.primaryCause : ""),
        confidence: browser?.confidence || (site.terminalStage === "browser" ? site.evidenceBasis : ""),
        supportingEvidence: browser?.strongestSupportingEvidence || (
          site.terminalStage === "browser" ? site.evidenceSummary : ""
        ),
        sourceArtifact: browser?.artifactPath || firstMatchingPath(site, /browser-stage\.json$/i),
      },
      discovery: {
        ruleId: discovery?.assessmentRuleId || (site.terminalStage === "discovery" ? site.ruleId : ""),
        reason: site.terminalStage === "discovery"
          ? site.primaryCause
          : site.discoveryAssessment
            ? `Discovery assessment: ${humanizeIdentifier(site.discoveryAssessment)}`
            : "",
        confidence: site.evidenceBasis,
        supportingEvidence: site.evidenceSummary,
        sourceArtifact: discovery?.artifactPath || firstMatchingPath(site, /discovery-debug\.json$/i),
      },
    }];
  }));
};

const safeJson = (value: unknown): string => JSON.stringify(value)
  .replaceAll("<", "\\u003c")
  .replaceAll(">", "\\u003e")
  .replaceAll("&", "\\u0026")
  .replaceAll("\u2028", "\\u2028")
  .replaceAll("\u2029", "\\u2029");

const bucketTone = (key: OutcomeBucketKey): string =>
  key === "continued" ? "continued" : key === "external_stop" ? "external" : "unresolved";

const renderSummarySection = (section: StageSignalDashboardSection): string => {
  const cards = section.buckets.map((bucket) => {
    const cardId = `${section.stage}-${bucket.key}`;
    return [
      `<button class="outcome-card ${bucketTone(bucket.key)}" type="button" id="${cardId}"`,
      ` data-stage="${section.stage}" data-bucket="${bucket.key}"`,
      ' aria-expanded="false" aria-controls="outcome-details">',
      `<span class="card-title">${escapeHtml(bucket.title)}</span>`,
      `<span class="card-count">${bucket.count.toLocaleString("en-US")}</span>`,
      `<span class="card-percent">${bucket.percentageOfEntrants.toFixed(2)}%</span>`,
      '<span class="card-action">View details <span aria-hidden="true">&#8595;</span></span>',
      "</button>",
    ].join("");
  }).join("");
  return [
    `<section class="stage-section" aria-labelledby="${section.stage}-heading">`,
    '<div class="stage-heading">',
    `<div><p class="eyebrow">Workflow stage</p><h2 id="${section.stage}-heading">${escapeHtml(section.title)}</h2></div>`,
    `<p class="entered"><strong>${section.entered.toLocaleString("en-US")}</strong> attempts entered</p>`,
    "</div>",
    `<div class="outcome-grid">${cards}</div>`,
    "</section>",
  ].join("");
};

export const renderBrowserDiscoverySignalsHtml = (result: AnalyticsResult): string => {
  const dashboardSections = buildBrowserDiscoverySignalDashboardData(result);
  const dashboard: BrowserDiscoveryDashboardData = {
    generatedAt: result.generatedAt,
    runPath: result.runPath,
    sections: [dashboardSections.browser, dashboardSections.discovery],
    attempts: buildDashboardAttempts(result),
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Browser and Discovery Outcome Explorer</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #111827; --muted: #5f6b7a; --line: #d7dde5; --surface: #fff;
      --page: #eef1f5; --stage: #273241; --focus: #2563eb;
      --green-bg: #dcfce7; --green-line: #15803d; --green-ink: #14532d;
      --grey-bg: #f3f4f6; --grey-line: #6b7280;
      --red-bg: #fee2e2; --red-line: #b91c1c;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--page); color: var(--ink); }
    button, input { font: inherit; }
    button { color: inherit; }
    .shell { width: min(1680px, calc(100% - 32px)); margin: 0 auto; padding: 40px 0 64px; }
    .page-header { padding: 30px 34px; border-radius: 18px; background: var(--stage); color: #f9fafb; box-shadow: 0 14px 34px rgba(17,24,39,.16); }
    .page-header h1 { margin: 4px 0 10px; font-size: clamp(28px,4vw,44px); line-height: 1.08; }
    .page-header p { margin: 0; color: #d1d5db; }
    .eyebrow { margin: 0; color: #6b7280; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .page-header .eyebrow { color: #a7f3d0; }
    .explorer-layout { display: grid; grid-template-columns: minmax(0,1.7fr) minmax(390px,.8fr); gap: 24px; align-items: start; margin-top: 28px; }
    .summary-column { display: grid; gap: 24px; }
    .stage-section { padding: 26px; border: 1px solid var(--line); border-radius: 18px; background: var(--surface); }
    .stage-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
    .stage-heading h2 { margin: 4px 0 0; font-size: 27px; }
    .entered { margin: 0; color: var(--muted); }
    .entered strong { color: var(--ink); font-size: 22px; }
    .outcome-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; }
    .outcome-card {
      min-height: 250px; padding: 24px; border: 2px solid; border-radius: 16px; text-align: left;
      cursor: pointer; display: flex; flex-direction: column; align-items: flex-start;
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .outcome-card:hover { transform: translateY(-2px); box-shadow: 0 12px 24px rgba(17,24,39,.12); }
    .outcome-card:focus-visible, .signal-button:focus-visible, .close-button:focus-visible, .show-more:focus-visible, input:focus-visible {
      outline: 3px solid var(--focus); outline-offset: 3px;
    }
    .outcome-card[aria-expanded="true"] { box-shadow: 0 0 0 4px rgba(37,99,235,.2); }
    .outcome-card.continued { background: var(--green-bg); border-color: var(--green-line); color: var(--green-ink); }
    .outcome-card.external { background: var(--grey-bg); border-color: var(--grey-line); }
    .outcome-card.unresolved { background: var(--red-bg); border-color: var(--red-line); }
    .card-title { min-height: 58px; font-size: 21px; font-weight: 800; line-height: 1.3; }
    .card-count { margin-top: 22px; font-size: clamp(38px,5vw,58px); font-weight: 850; line-height: 1; }
    .card-percent { margin-top: 8px; font-size: 21px; font-weight: 750; }
    .card-action { margin-top: auto; padding-top: 24px; font-size: 14px; font-weight: 800; }
    .detail-panel { position: sticky; top: 20px; min-height: min(720px,calc(100vh - 40px)); max-height: calc(100vh - 40px); overflow: auto; padding: 26px; border: 1px solid #cbd5e1; border-radius: 18px; background: #f8fafc; }
    .detail-panel.is-empty { background: rgba(248,250,252,.58); }
    .detail-panel.continued { background: var(--green-bg); border-color: var(--green-line); }
    .detail-panel.external { background: var(--grey-bg); border-color: var(--grey-line); }
    .detail-panel.unresolved { background: var(--red-bg); border-color: var(--red-line); }
    .attempt-panel[hidden] { display: none; }
    .detail-header { display: flex; justify-content: space-between; align-items: start; gap: 20px; }
    .detail-header h3 { margin: 3px 0 8px; font-size: 25px; }
    .detail-summary { margin: 0; color: var(--muted); }
    .close-button, .show-more { border: 1px solid #64748b; border-radius: 10px; background: #fff; padding: 9px 13px; cursor: pointer; font-weight: 750; }
    .signal-families { display: grid; grid-template-columns: 1fr; gap: 16px; margin-top: 24px; }
    .signal-family { padding: 16px; border: 1px solid var(--line); border-radius: 13px; background: #fff; }
    .signal-family h4 { margin: 0 0 10px; font-size: 15px; color: #374151; }
    .signal-list { display: grid; gap: 8px; }
    .signal-button {
      width: 100%; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 16px; align-items: center;
      padding: 11px 12px; border: 1px solid #dbe2ea; border-radius: 10px; background: #f8fafc; cursor: pointer; text-align: left;
    }
    .signal-button:hover, .signal-button[aria-expanded="true"] { border-color: #64748b; background: #eef2f7; }
    .signal-name { font-weight: 750; }
    .signal-metrics { color: var(--muted); font-size: 13px; text-align: right; white-space: nowrap; }
    .attempt-panel { margin-top: 24px; padding-top: 22px; border-top: 2px solid #cbd5e1; }
    .attempt-panel h4 { margin: 0 0 4px; font-size: 21px; }
    .attempt-tools { display: flex; align-items: end; justify-content: space-between; gap: 14px; margin: 16px 0; }
    .search-label { display: grid; gap: 6px; width: min(520px,100%); color: #374151; font-size: 13px; font-weight: 750; }
    .search-label input { width: 100%; padding: 10px 12px; border: 1px solid #9ca3af; border-radius: 9px; background: #fff; }
    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 12px; background: #fff; }
    table { width: 100%; min-width: 1250px; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 11px 12px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { position: sticky; top: 0; background: #e8edf3; color: #374151; font-size: 12px; letter-spacing: .03em; }
    tr:last-child td { border-bottom: 0; }
    .show-more { margin-top: 14px; padding: 10px 16px; }
    .empty { color: var(--muted); font-style: italic; }
    .footnote { margin: 28px 4px 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
    @media (max-width: 1280px) { .outcome-grid { grid-template-columns: 1fr; } .outcome-card { min-height: 210px; } }
    @media (max-width: 980px) {
      .explorer-layout { grid-template-columns: 1fr; }
      .outcome-grid { grid-template-columns: repeat(3,minmax(0,1fr)); }
      .detail-panel { position: static; min-height: 320px; max-height: none; }
    }
    @media (max-width: 760px) { .outcome-grid { grid-template-columns: 1fr; } }
    @media (max-width: 620px) {
      .shell { width: min(100% - 18px,1680px); padding-top: 10px; }
      .page-header, .stage-section, .detail-panel { padding: 20px; border-radius: 14px; }
      .stage-heading, .detail-header, .attempt-tools { align-items: stretch; flex-direction: column; }
    }
    @media (prefers-reduced-motion: reduce) { .outcome-card { transition: none; } }
  </style>
</head>
<body>
  <main class="shell" id="browser-discovery-explorer" data-ready="false">
    <header class="page-header">
      <p class="eyebrow">Contact outreach analytics</p>
      <h1>Browser &amp; Discovery Outcome Explorer</h1>
      <p>Generated ${escapeHtml(result.generatedAt)}. Select an outcome to inspect its canonical evidence signals.</p>
    </header>
    <div class="explorer-layout">
      <div class="summary-column">
        ${renderSummarySection(dashboardSections.browser)}
        ${renderSummarySection(dashboardSections.discovery)}
      </div>
      <aside class="detail-panel is-empty" id="outcome-details" aria-label="Selected outcome details" aria-live="polite"></aside>
    </div>
    <p class="footnote">Every stage entrant appears in exactly one outcome card. Signal counts are deduplicated per attempt, but signals may overlap. URL-specific diagnostic reasons are grouped under stable canonical labels.</p>
  </main>
  <script id="dashboard-data" type="application/json">${safeJson(dashboard)}</script>
  <script>
    (function () {
      "use strict";
      var root = document.getElementById("browser-discovery-explorer");
      var data = JSON.parse(document.getElementById("dashboard-data").textContent || "{}");
      var sectionByStage = new Map(data.sections.map(function (section) { return [section.stage, section]; }));
      var activeCard = null;
      var activeSignalButton = null;
      var selectedSignal = null;
      var selectedStage = "";
      var visibleLimit = 50;

      function element(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      }
      function percentage(value) { return Number(value || 0).toFixed(2) + "%"; }
      function bucketDescription(stage, key) {
        if (key === "continued") return stage === "browser"
          ? "The website loaded and the attempt continued to Discovery."
          : "A suitable form was identified and the attempt continued to Population.";
        if (key === "external_stop") return stage === "browser"
          ? "Strong evidence indicates that the destination website, link, or external service caused the stop."
          : "Strong evidence indicates that the website does not provide a suitable contact form.";
        return "The available evidence does not establish that the cause was entirely external to the automation.";
      }
      function closeActive(restoreFocus) {
        if (!activeCard) return;
        var card = activeCard;
        var panel = document.getElementById("outcome-details");
        card.setAttribute("aria-expanded", "false");
        panel.replaceChildren();
        panel.classList.remove("continued", "external", "unresolved");
        panel.classList.add("is-empty");
        activeCard = null; activeSignalButton = null; selectedSignal = null;
        if (restoreFocus) card.focus();
      }
      function createSignalButton(signal, bucket, stage, attemptPanel) {
        var button = element("button", "signal-button");
        button.type = "button";
        button.setAttribute("aria-expanded", "false");
        button.append(
          element("span", "signal-name", signal.label),
          element("span", "signal-metrics",
            signal.count.toLocaleString("en-US") + " \\u00b7 " +
            (bucket.count ? signal.count / bucket.count * 100 : 0).toFixed(2) + "% of box \\u00b7 " +
            percentage(signal.percentageOfEntrants) + " of stage")
        );
        button.addEventListener("click", function () {
          if (activeSignalButton === button) {
            button.setAttribute("aria-expanded", "false");
            activeSignalButton = null; selectedSignal = null; attemptPanel.hidden = true;
            return;
          }
          if (activeSignalButton) activeSignalButton.setAttribute("aria-expanded", "false");
          activeSignalButton = button; selectedSignal = signal; selectedStage = stage; visibleLimit = 50;
          button.setAttribute("aria-expanded", "true");
          renderAttemptPanel(attemptPanel);
        });
        return button;
      }
      function renderAttemptPanel(panel) {
        panel.replaceChildren();
        panel.hidden = false;
        panel.append(
          element("h4", "", selectedSignal.label),
          element("p", "detail-summary",
            selectedSignal.count.toLocaleString("en-US") + " affected attempt" + (selectedSignal.count === 1 ? "" : "s"))
        );
        var tools = element("div", "attempt-tools");
        var label = element("label", "search-label", "Search by attempt ID or website");
        var input = document.createElement("input");
        input.type = "search"; input.placeholder = "Type to filter attempts";
        label.appendChild(input); tools.appendChild(label);
        var tableWrap = element("div", "table-wrap");
        var showMore = element("button", "show-more", "Show more");
        showMore.type = "button";
        panel.append(tools, tableWrap, showMore);
        function matchingAttempts() {
          var query = input.value.trim().toLowerCase();
          return selectedSignal.siteIds.map(function (id) { return data.attempts[id]; }).filter(Boolean)
            .filter(function (attempt) {
              return !query || attempt.id.toLowerCase().includes(query) ||
                (attempt.websiteUrl || "").toLowerCase().includes(query);
            });
        }
        function renderRows() {
          var attempts = matchingAttempts();
          tableWrap.replaceChildren();
          if (!attempts.length) {
            tableWrap.appendChild(element("p", "empty", "No attempts match this search."));
            showMore.hidden = true; return;
          }
          var table = document.createElement("table");
          var head = document.createElement("thead");
          var headRow = document.createElement("tr");
          ["Attempt ID", "Website", "Classification rule", "Reason", "Confidence", "Supporting evidence", "Source artifact"]
            .forEach(function (heading) {
              var th = document.createElement("th"); th.scope = "col"; th.textContent = heading; headRow.appendChild(th);
            });
          head.appendChild(headRow);
          var body = document.createElement("tbody");
          attempts.slice(0, visibleLimit).forEach(function (attempt) {
            var details = attempt[selectedStage];
            var row = document.createElement("tr");
            [attempt.id, attempt.websiteUrl || "\\u2014", details.ruleId || "\\u2014", details.reason || "\\u2014",
              details.confidence || "\\u2014", details.supportingEvidence || "\\u2014", details.sourceArtifact || "\\u2014"]
              .forEach(function (value) {
                var cell = document.createElement("td"); cell.textContent = value; row.appendChild(cell);
              });
            body.appendChild(row);
          });
          table.append(head, body); tableWrap.appendChild(table);
          showMore.hidden = attempts.length <= visibleLimit;
          showMore.textContent = "Show 50 more (" + Math.max(0, attempts.length - visibleLimit) + " remaining)";
        }
        input.addEventListener("input", function () { visibleLimit = 50; renderRows(); });
        showMore.addEventListener("click", function () { visibleLimit += 50; renderRows(); });
        renderRows();
      }
      function openCard(card) {
        var stage = card.dataset.stage;
        var bucketKey = card.dataset.bucket;
        var section = sectionByStage.get(stage);
        var bucket = section.buckets.find(function (candidate) { return candidate.key === bucketKey; });
        var panel = document.getElementById("outcome-details");
        var header = element("div", "detail-header");
        var headingGroup = element("div");
        headingGroup.append(
          element("p", "eyebrow", section.title + " outcome"),
          element("h3", "", bucket.title),
          element("p", "detail-summary",
            bucket.count.toLocaleString("en-US") + " attempts \\u00b7 " + percentage(bucket.percentageOfEntrants) +
            " of stage entrants. " + bucketDescription(stage, bucket.key))
        );
        var close = element("button", "close-button", "Close details");
        close.type = "button"; close.addEventListener("click", function () { closeActive(true); });
        header.append(headingGroup, close);
        var families = new Map();
        bucket.signals.forEach(function (signal) {
          var values = families.get(signal.family) || []; values.push(signal); families.set(signal.family, values);
        });
        var familyGrid = element("div", "signal-families");
        var attemptPanel = element("section", "attempt-panel"); attemptPanel.hidden = true;
        families.forEach(function (signals, family) {
          var familyCard = element("section", "signal-family");
          familyCard.appendChild(element("h4", "", family));
          var list = element("div", "signal-list");
          signals.forEach(function (signal) {
            list.appendChild(createSignalButton(signal, bucket, stage, attemptPanel));
          });
          familyCard.appendChild(list); familyGrid.appendChild(familyCard);
        });
        if (!bucket.signals.length) familyGrid.appendChild(element("p", "empty", "No canonical signals were recorded for this outcome."));
        panel.replaceChildren(header, familyGrid, attemptPanel);
        panel.classList.remove("is-empty", "continued", "external", "unresolved");
        panel.classList.add(card.classList.contains("continued") ? "continued" : card.classList.contains("external") ? "external" : "unresolved");
        card.setAttribute("aria-expanded", "true"); activeCard = card;
      }
      document.querySelectorAll(".outcome-card").forEach(function (card) {
        card.addEventListener("click", function () {
          if (activeCard === card) { closeActive(false); return; }
          closeActive(false); openCard(card);
        });
      });
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && activeCard) closeActive(true);
      });
      root.setAttribute("data-ready", "true");
    }());
  </script>
</body>
</html>
`;
};
