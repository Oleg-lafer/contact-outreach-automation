import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AnalyticsError,
  AnalyticsResult,
  DiscoveryChannelAnalyticsResult,
  DiscoveryNormalizedOutcome,
  FormSignalStatistic,
  FormSignalStatistics,
  OutreachAnalyticsResult,
  SiteClassification,
  StageStatistics,
} from "./analytics_types.js";
import { DISCOVERY_OUTCOMES } from "./analytics_types.js";
import { discoveryChannelRulebook } from "./discovery_channel_analyzer.js";
import { serializedRulebook } from "./rulebook.js";
import { renderProportionalFunnelSvg } from "./proportional_funnel_svg.js";
import {
  renderSignalDashboardHtml,
  renderSignalDashboardPng,
} from "./signal_dashboard.js";

type OutputFile = string | Buffer;
type OutputFiles = Record<string, OutputFile>;

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? "" : Array.isArray(value) ? value.join(" | ") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const csv = (headers: string[], rows: unknown[][]): string =>
  [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";

const formatPercent = (value: number): string => `${value.toFixed(2)}%`;
const siteList = (ids: string[]): string => (ids.length === 0 ? "none" : ids.join(", "));

const renderStage = (stage: StageStatistics, includeSiteLists: boolean): string[] => {
  const lines = [
    `${stage.stage.toUpperCase()} STAGE`,
    `Applicable: ${stage.applicable}`,
    `Entered: ${stage.entered}`,
    `Advanced / qualified / completed: ${stage.advancedOrQualifiedOrCompleted} (${formatPercent(stage.advanceRateAmongEntrants)} of entrants)`,
    `Stopped: ${stage.stopped} (${formatPercent(stage.stopRateAmongEntrants)} of entrants)`,
    `Incomplete: ${stage.incomplete}`,
    `Not applicable: ${stage.notApplicable}`,
    "Terminal attribution:",
  ];
  for (const value of ["workflow_attributable", "non_workflow_attributable", "indeterminate", "not_applicable"] as const) {
    const group = stage.attribution[value];
    lines.push(
      includeSiteLists ? `  ${value}: ${group.count} [${siteList(group.siteIds)}]` : `  ${value}: ${group.count}`,
    );
  }
  lines.push("Subcategories:");
  if (stage.subcategories.length === 0) lines.push("  none");
  for (const category of stage.subcategories) {
    const base = `  ${category.subcategory} | ${category.attribution} | ${category.causeFamily}: ${category.count}`;
    lines.push(includeSiteLists ? `${base} [${siteList(category.siteIds)}]` : base);
  }
  return lines;
};

const renderTextReport = (result: AnalyticsResult, includeSiteLists: boolean): string => {
  const counts = result.counts;
  const lines = [
    "DETERMINISTIC CONTACT-FORM RUN ANALYTICS",
    "========================================",
    `Run: ${result.runPath}`,
    `Detected mode: ${result.runMode}`,
    `Generated: ${result.generatedAt}`,
    `Schema version: ${result.schemaVersion}`,
    `Rulebook version: ${result.rulebookVersion}`,
    "",
    "RUN COVERAGE",
    `Planned: ${counts.planned ?? "unknown"}`,
    `Processed site directories: ${counts.processed}`,
    `Completed Full successes: ${counts.completed}`,
    `Qualified Discovery sites: ${counts.qualified}`,
    `Stopped with a terminal cause: ${counts.stopped}`,
    `Incomplete (excluded from responsibility totals): ${counts.incomplete}`,
    `Not started: ${counts.notStarted ?? "unknown"}`,
    `Terminal results: ${counts.terminalResults}`,
    "",
    "FINAL RESPONSIBILITY ATTRIBUTION",
    "Percent of completed sites uses all terminal results (completed + qualified + stopped) as its denominator.",
  ];
  for (const value of ["workflow_attributable", "non_workflow_attributable", "indeterminate"] as const) {
    const group = result.finalAttribution[value];
    lines.push(
      `${value}: ${group.count} | ${formatPercent(group.percentageOfStopped)} of stopped | ${formatPercent(group.percentageOfCompletedSites)} of terminal results`,
    );
    if (includeSiteLists) lines.push(`  Sites: ${siteList(group.siteIds)}`);
  }
  lines.push("", "STAGE FUNNEL");
  for (const stage of result.stages) lines.push("", ...renderStage(stage, includeSiteLists));
  lines.push("", "DATA QUALITY AND RECONCILIATION");
  lines.push(`Processed equals completed + qualified + stopped + incomplete: ${result.reconciliation.processedEqualsStates ? "yes" : "NO"}`);
  lines.push(`Stopped equals the three responsibility groups: ${result.reconciliation.stoppedEqualsAttributions ? "yes" : "NO"}`);
  lines.push(`One classification per site ID: ${result.reconciliation.uniqueSiteClassifications ? "yes" : "NO"}`);
  lines.push(`No primary subcategory double-counting within a stage: ${result.reconciliation.stageSubcategoriesDoNotDoubleCount ? "yes" : "NO"}`);
  lines.push(`Artifact errors/warnings: ${result.errors.length}`);
  lines.push(`Data-quality warnings: ${result.dataQualityWarnings.length}`);
  for (const warning of result.dataQualityWarnings) lines.push(`  - ${warning}`);
  return `${lines.join("\r\n")}\r\n`;
};

const renderMermaidDefinition = (result: AnalyticsResult): string => {
  const stage = (name: StageStatistics["stage"]): StageStatistics => {
    const found = result.stages.find((candidate) => candidate.stage === name);
    if (!found) throw new Error(`Missing ${name} stage statistics.`);
    return found;
  };
  const input = stage("input");
  const browser = stage("browser");
  const discovery = stage("discovery");
  const population = stage("population");
  const submission = stage("submission");
  const reporting = stage("reporting");
  const counts = result.counts;
  const planned = counts.planned ?? counts.processed;
  const notStarted = counts.notStarted ?? 0;

  return [
    "flowchart TD",
    `  PLAN[\"Planned sites<br/><b>${planned}</b>\"]`,
    `  PLAN -->|Run started: ${counts.processed}| INPUT[\"Input stage<br/>Entered: ${input.entered}\"]`,
    `  PLAN -->|Run not started: ${notStarted}| NOTSTARTED[\"Not executed<br/><b>${notStarted}</b>\"]`,
    `  INPUT -->|Input success: ${input.advancedOrQualifiedOrCompleted}| EVIDENCE{\"Terminal result artifact?\"}`,
    `  INPUT -->|Input failure: ${input.stopped}| INPUTFAIL[\"Input failures<br/><b>${input.stopped}</b>\"]`,
    `  EVIDENCE -->|Reporting evidence available: ${counts.terminalResults}| BROWSER[\"Browser stage<br/>Entered: ${browser.entered}\"]`,
    `  EVIDENCE -->|Reporting evidence incomplete: ${counts.incomplete}| INCOMPLETE[\"Incomplete / still running<br/><b>${counts.incomplete}</b><br/>Excluded from responsibility totals\"]`,
    `  BROWSER -->|Browser success: ${browser.advancedOrQualifiedOrCompleted} (${formatPercent(browser.advanceRateAmongEntrants)})| DISCOVERY[\"Discovery stage<br/>Entered: ${discovery.entered}\"]`,
    `  BROWSER -->|Browser failure: ${browser.stopped} (${formatPercent(browser.stopRateAmongEntrants)})| BROWSERFAIL[\"Browser failures<br/><b>${browser.stopped}</b><br/>Non-workflow: ${browser.attribution.non_workflow_attributable.count}<br/>Indeterminate: ${browser.attribution.indeterminate.count}\"]`,
    `  DISCOVERY -->|Discovery success: ${discovery.advancedOrQualifiedOrCompleted} (${formatPercent(discovery.advanceRateAmongEntrants)})| POPULATION[\"Population stage<br/>Entered: ${population.entered}\"]`,
    `  DISCOVERY -->|Discovery failure: ${discovery.stopped} (${formatPercent(discovery.stopRateAmongEntrants)})| DISCOVERYFAIL[\"Discovery failures<br/><b>${discovery.stopped}</b><br/>Non-workflow: ${discovery.attribution.non_workflow_attributable.count}<br/>Indeterminate: ${discovery.attribution.indeterminate.count}\"]`,
    `  POPULATION -->|Population success: ${population.advancedOrQualifiedOrCompleted} (${formatPercent(population.advanceRateAmongEntrants)})| SUBMISSION[\"Submission stage<br/>Entered: ${submission.entered}\"]`,
    `  POPULATION -->|Population failure: ${population.stopped} (${formatPercent(population.stopRateAmongEntrants)})| POPULATIONFAIL[\"Population failures<br/><b>${population.stopped}</b><br/>Workflow-attributable: ${population.attribution.workflow_attributable.count}\"]`,
    `  SUBMISSION -->|Submission success: ${submission.advancedOrQualifiedOrCompleted} (${formatPercent(submission.advanceRateAmongEntrants)})| SUCCESS[\"Confirmed successful submissions<br/><b>${counts.completed}</b>\"]`,
    `  SUBMISSION -->|Submission failure: ${submission.stopped} (${formatPercent(submission.stopRateAmongEntrants)})| SUBMISSIONFAIL[\"Submission failures<br/><b>${submission.stopped}</b><br/>Workflow: ${submission.attribution.workflow_attributable.count}<br/>Non-workflow: ${submission.attribution.non_workflow_attributable.count}<br/>Indeterminate: ${submission.attribution.indeterminate.count}\"]`,
    `  SUCCESS -.-> REPORTING[\"Reporting evidence<br/>Complete terminal artifacts: ${reporting.advancedOrQualifiedOrCompleted}<br/>Incomplete: ${reporting.incomplete}\"]`,
    "",
    "  classDef success fill:#dcfce7,stroke:#15803d,color:#14532d;",
    "  classDef failure fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d;",
    "  classDef warning fill:#fef3c7,stroke:#b45309,color:#78350f;",
    "  classDef stage fill:#dbeafe,stroke:#1d4ed8,color:#1e3a8a;",
    "  class INPUT,BROWSER,DISCOVERY,POPULATION,SUBMISSION,PLAN,EVIDENCE,REPORTING stage;",
    "  class SUCCESS success;",
    "  class INPUTFAIL,BROWSERFAIL,DISCOVERYFAIL,POPULATIONFAIL,SUBMISSIONFAIL failure;",
    "  class NOTSTARTED,INCOMPLETE warning;",
  ]
    .join("\r\n")
    .replace(/-->\|([^|\r\n]+)\|/g, '-->|"$1"|');
};

export const renderMermaidReport = (result: AnalyticsResult): string =>
  [
    "# Contact-form run funnel",
    "",
    `Generated from \`qualitative-statistics.json\` at ${result.generatedAt}.`,
    "",
    "```mermaid",
    renderMermaidDefinition(result),
    "```",
    "",
    "Notes:",
    "",
    '- "Success" on an intermediate arrow means the site advanced to the next stage; only the final green node is a confirmed submission success.',
    "- Incomplete directories are not treated as failures and are excluded from responsibility attribution.",
    "- Reporting is cross-cutting: a report can record either an earlier-stage failure or a final success.",
    "",
  ].join("\r\n");

const mermaidSvgCache = new Map<string, Promise<string>>();

const renderMermaidSvgUncached = async (definition: string): Promise<string> => {
  const { chromium } = await import("playwright");
  const mermaidBrowserBundle = path.join(
    path.dirname(import.meta.dirname),
    "..",
    "node_modules",
    "mermaid",
    "dist",
    "mermaid.min.js",
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ colorScheme: "light" });
    await page.setContent("<main id=\"mermaid-render-target\"></main>");
    await page.addScriptTag({ path: mermaidBrowserBundle });
    return await page.evaluate(async (source) => {
      const mermaidApi = (
        window as unknown as {
          mermaid: {
            initialize: (configuration: Record<string, unknown>) => void;
            render: (
              id: string,
              definition: string,
            ) => Promise<{ svg: string }>;
          };
        }
      ).mermaid;
      mermaidApi.initialize({
        startOnLoad: false,
        theme: "default",
        securityLevel: "strict",
      });
      const rendered = await mermaidApi.render("contact-form-funnel", source);
      return rendered.svg.replace(/<br>/gi, "<br/>");
    }, definition);
  } finally {
    await browser.close();
  }
};

const renderMermaidSvg = async (result: AnalyticsResult): Promise<string> => {
  const definition = renderMermaidDefinition(result);
  const cached = mermaidSvgCache.get(definition);
  if (cached) return cached;
  const rendering = renderMermaidSvgUncached(definition);
  mermaidSvgCache.set(definition, rendering);
  try {
    return await rendering;
  } catch (error) {
    mermaidSvgCache.delete(definition);
    throw error;
  }
};

const stageCsv = (result: AnalyticsResult): string => {
  const rows: unknown[][] = [];
  for (const stage of result.stages) {
    if (stage.subcategories.length === 0) {
      rows.push([
        stage.stage,
        "",
        "",
        "",
        0,
        "",
        stage.entered,
        stage.advancedOrQualifiedOrCompleted,
        stage.stopped,
        stage.advanceRateAmongEntrants,
        stage.stopRateAmongEntrants,
      ]);
    }
    for (const category of stage.subcategories) {
      rows.push([
        stage.stage,
        category.attribution,
        category.causeFamily,
        category.subcategory,
        category.count,
        category.siteIds,
        stage.entered,
        stage.advancedOrQualifiedOrCompleted,
        stage.stopped,
        stage.advanceRateAmongEntrants,
        stage.stopRateAmongEntrants,
      ]);
    }
  }
  return csv(
    [
      "stage",
      "attribution",
      "cause_family",
      "subcategory",
      "count",
      "site_ids",
      "stage_entered",
      "stage_advanced_qualified_completed",
      "stage_stopped",
      "advance_rate_among_entrants_percent",
      "stop_rate_among_entrants_percent",
    ],
    rows,
  );
};

const siteCsv = (sites: SiteClassification[]): string =>
  csv(
    [
      "site_id",
      "website_url",
      "mode",
      "run_state",
      "terminal_stage",
      "attribution",
      "cause_family",
      "subcategory",
      "rule_id",
      "evidence_basis",
      "primary_cause",
      "evidence_summary",
      "failure_kind",
      "discovery_assessment",
      "secondary_signals",
      "source_paths",
      "source_directory",
    ],
    sites.map((site) => [
      site.id,
      site.websiteUrl,
      site.mode,
      site.runState,
      site.terminalStage,
      site.attribution,
      site.causeFamily,
      site.subcategory,
      site.ruleId,
      site.evidenceBasis,
      site.primaryCause,
      site.evidenceSummary,
      site.failureKind,
      site.discoveryAssessment,
      site.secondarySignals,
      site.sourcePaths,
      site.sourceDirectory,
    ]),
  );

const errorsCsv = (errors: AnalyticsError[]): string =>
  csv(
    ["site_id", "severity", "code", "message", "source_path"],
    errors.map((error) => [error.siteId, error.severity, error.code, error.message, error.sourcePath]),
  );

const outcomeLabel = (outcome: DiscoveryNormalizedOutcome): string =>
  outcome.replaceAll("_", " ").replace(/\b\w/g, (value) => value.toUpperCase());

const renderDiscoveryText = (result: DiscoveryChannelAnalyticsResult): string => {
  const lines = [
    `DETERMINISTIC ${result.channel.toUpperCase()} DISCOVERY ANALYTICS`,
    "=".repeat(48),
    `Run: ${result.runPath}`,
    `Generated: ${result.generatedAt}`,
    `Schema version: ${result.schemaVersion}`,
    `Rulebook version: ${result.rulebookVersion}`,
    "",
    "RUN COVERAGE",
    `Planned: ${result.counts.planned ?? "unknown"}`,
    `Processed site directories: ${result.counts.processed}`,
    `Not started: ${result.counts.notStarted ?? "unknown"}`,
    `Complete page coverage: ${result.counts.completeCoverage.count} (${formatPercent(result.counts.coverageCompletionRate)})`,
    `Incomplete page coverage: ${result.counts.incompleteCoverage.count}`,
    "",
    "NORMALIZED OUTCOMES",
  ];
  for (const outcome of DISCOVERY_OUTCOMES) {
    const group = result.counts.outcomes[outcome];
    lines.push(`${outcome}: ${group.count} [${siteList(group.siteIds)}]`);
  }
  lines.push(
    "",
    "RAW WORKFLOW STATUSES",
    ...(["SUCCESS", "PARTIAL", "FAILED", "MISSING", "OTHER"] as const).map((status) => {
      const group = result.counts.rawStatuses[status];
      return `${status}: ${group.count} [${siteList(group.siteIds)}]`;
    }),
    "",
    "OPPORTUNITY METRICS",
    `Discovered items: ${result.counts.totalDiscoveredItems}`,
    `Unique discovered items: ${result.counts.uniqueDiscoveredItems}`,
    `Opportunity rate among complete searches: ${formatPercent(result.counts.opportunityRateAmongCompleteSearches)}`,
  );
  if (result.providerCounts) {
    lines.push("", "MEETING PROVIDERS");
    const providers = Object.entries(result.providerCounts);
    if (providers.length === 0) lines.push("none");
    for (const [provider, group] of providers) {
      lines.push(`${provider}: ${group.count} [${siteList(group.siteIds)}]`);
    }
  }
  lines.push(
    "",
    "RECONCILIATION",
    `One classification per site: ${result.reconciliation.oneClassificationPerSite ? "yes" : "NO"}`,
    `Processed equals outcome total: ${result.reconciliation.processedEqualsOutcomeTotal ? "yes" : "NO"}`,
    `Item counts match parsed items: ${result.reconciliation.itemCountsMatchParsedItems ? "yes" : "NO"}`,
    `Coverage groups reconcile: ${result.reconciliation.coverageCountsReconcile ? "yes" : "NO"}`,
  );
  return `${lines.join("\r\n")}\r\n`;
};

const discoveryOutcomeCsv = (result: DiscoveryChannelAnalyticsResult): string =>
  csv(
    ["outcome", "count", "percentage_of_processed", "site_ids"],
    DISCOVERY_OUTCOMES.map((outcome) => {
      const group = result.counts.outcomes[outcome];
      const pct = result.counts.processed === 0 ? 0 : (group.count / result.counts.processed) * 100;
      return [outcome, group.count, Number(pct.toFixed(2)), group.siteIds];
    }),
  );

const discoverySiteCsv = (result: DiscoveryChannelAnalyticsResult): string =>
  csv(
    [
      "site_id",
      "website_url",
      "outcome",
      "rule_id",
      "raw_status",
      "reason",
      "failure_kind",
      "item_count",
      "items",
      "providers",
      "planned_pages",
      "inspected_pages",
      "failed_pages",
      "complete_coverage",
      "evidence_summary",
      "source_paths",
      "source_directory",
    ],
    result.sites.map((site) => [
      site.id,
      site.websiteUrl,
      site.outcome,
      site.ruleId,
      site.rawStatus,
      site.reason,
      site.failureKind,
      site.itemCount,
      site.items,
      site.providers,
      site.plannedPages,
      site.inspectedPages,
      site.failedPages,
      site.completeCoverage,
      site.evidenceSummary,
      site.sourcePaths,
      site.sourceDirectory,
    ]),
  );

const escapeXml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const DISCOVERY_COLORS: Record<DiscoveryNormalizedOutcome, string> = {
  found_complete: "#16a34a",
  found_partial: "#65a30d",
  no_opportunity: "#2563eb",
  incomplete: "#d97706",
  execution_failed: "#dc2626",
  artifact_incomplete: "#6b7280",
  conflicting: "#9333ea",
};

export const renderDiscoveryChannelSvg = (result: DiscoveryChannelAnalyticsResult): string => {
  const width = 1100;
  const rowHeight = 62;
  const top = 155;
  const height = top + DISCOVERY_OUTCOMES.length * rowHeight + 120;
  const maximumBarWidth = 650;
  const channelTitle = `${result.channel[0]?.toUpperCase()}${result.channel.slice(1)} discovery outcomes`;
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">`,
    `  <title id="title">${escapeXml(result.channel)} discovery outcomes</title>`,
    `  <desc id="description">Independent normalized outcomes and planned-page coverage for the ${escapeXml(result.channel)} channel.</desc>`,
    "  <style>",
    "    text { font-family: Inter, Segoe UI, Arial, sans-serif; fill: #111827; }",
    "    .title { font-size: 27px; font-weight: 600; }",
    "    .subtitle { font-size: 14px; fill: #4b5563; }",
    "    .label { font-size: 15px; }",
    "    .value { font-size: 14px; font-weight: 600; }",
    "  </style>",
    `  <text x="36" y="42" class="title">${escapeXml(channelTitle)}</text>`,
    `  <text x="36" y="70" class="subtitle">Generated ${escapeXml(result.generatedAt)} | Each bar uses processed sites (${result.counts.processed}) as its denominator</text>`,
    `  <text x="36" y="100" class="subtitle">Complete coverage: ${result.counts.completeCoverage.count} (${result.counts.coverageCompletionRate.toFixed(2)}%) | Incomplete coverage: ${result.counts.incompleteCoverage.count}</text>`,
  ];
  DISCOVERY_OUTCOMES.forEach((outcome, index) => {
    const count = result.counts.outcomes[outcome].count;
    const pct = result.counts.processed === 0 ? 0 : (count / result.counts.processed) * 100;
    const barWidth = result.counts.processed === 0 ? 0 : (count / result.counts.processed) * maximumBarWidth;
    const y = top + index * rowHeight;
    lines.push(
      `  <text x="36" y="${y + 20}" class="label">${escapeXml(outcomeLabel(outcome))}</text>`,
      `  <rect x="270" y="${y}" width="${barWidth.toFixed(2)}" height="30" rx="4" fill="${DISCOVERY_COLORS[outcome]}" data-outcome="${outcome}" data-count="${count}" data-percentage="${pct.toFixed(2)}"/>`,
      `  <text x="${Math.max(280, 282 + barWidth).toFixed(2)}" y="${y + 20}" class="value">${count} (${pct.toFixed(2)}%)</text>`,
    );
  });
  lines.push("</svg>", "");
  return lines.join("\n");
};

const renderOutreachText = (result: OutreachAnalyticsResult): string => {
  const { forms, emails, meetings } = result.channels;
  const lines = [
    "DETERMINISTIC CONTACT-OUTREACH ANALYTICS",
    "========================================",
    `Run: ${result.runPath}`,
    `Detected mode: ${result.runMode}`,
    `Generated: ${result.generatedAt}`,
    `Schema version: ${result.schemaVersion}`,
    "",
    "RUN COVERAGE",
    `Planned: ${result.planned ?? "unknown"}`,
    `Processed site directories: ${result.processed}`,
    `Not started: ${result.notStarted ?? "unknown"}`,
    "",
    "FORMS",
    `Completed: ${forms.counts.completed}`,
    `Qualified: ${forms.counts.qualified}`,
    `Stopped: ${forms.counts.stopped}`,
    `Incomplete: ${forms.counts.incomplete}`,
    "",
    "EMAILS",
    ...DISCOVERY_OUTCOMES.map((outcome) => `${outcome}: ${emails.counts.outcomes[outcome].count}`),
    `Opportunity rate among complete searches: ${formatPercent(emails.counts.opportunityRateAmongCompleteSearches)}`,
    `Coverage completion rate: ${formatPercent(emails.counts.coverageCompletionRate)}`,
    "",
    "MEETINGS",
    ...DISCOVERY_OUTCOMES.map((outcome) => `${outcome}: ${meetings.counts.outcomes[outcome].count}`),
    `Opportunity rate among complete searches: ${formatPercent(meetings.counts.opportunityRateAmongCompleteSearches)}`,
    `Coverage completion rate: ${formatPercent(meetings.counts.coverageCompletionRate)}`,
    "",
    "CROSS-CHANNEL RECONCILIATION",
    `Unique site evidence: ${result.reconciliation.uniqueSiteEvidence ? "yes" : "NO"}`,
    `Every channel classified every site: ${result.reconciliation.allChannelsClassifyEverySite ? "yes" : "NO"}`,
    `Channel site IDs align: ${result.reconciliation.channelSiteIdsAlign ? "yes" : "NO"}`,
    `Planned count is not below processed: ${result.reconciliation.plannedCountIsNotBelowProcessed ? "yes" : "NO"}`,
    `Artifact errors/warnings: ${result.errors.length}`,
    `Data-quality warnings: ${result.dataQualityWarnings.length}`,
    ...result.dataQualityWarnings.map((warning) => `  - ${warning}`),
  ];
  return `${lines.join("\r\n")}\r\n`;
};

const siteChannelMatrixCsv = (result: OutreachAnalyticsResult): string => {
  const emails = new Map(result.channels.emails.sites.map((site) => [site.id, site]));
  const meetings = new Map(result.channels.meetings.sites.map((site) => [site.id, site]));
  return csv(
    [
      "site_id",
      "website_url",
      "form_run_state",
      "form_status",
      "form_terminal_stage",
      "form_failure_kind",
      "email_outcome",
      "email_status",
      "email_item_count",
      "email_complete_coverage",
      "email_failure_kind",
      "meeting_outcome",
      "meeting_status",
      "meeting_item_count",
      "meeting_complete_coverage",
      "meeting_failure_kind",
    ],
    result.channels.forms.sites.map((form) => {
      const email = emails.get(form.id);
      const meeting = meetings.get(form.id);
      return [
        form.id,
        form.websiteUrl,
        form.runState,
        form.status,
        form.terminalStage,
        form.failureKind,
        email?.outcome ?? "",
        email?.rawStatus ?? "",
        email?.itemCount ?? "",
        email?.completeCoverage ?? "",
        email?.failureKind ?? "",
        meeting?.outcome ?? "",
        meeting?.rawStatus ?? "",
        meeting?.itemCount ?? "",
        meeting?.completeCoverage ?? "",
        meeting?.failureKind ?? "",
      ];
    }),
  );
};

const formSignalCsv = (items: FormSignalStatistic[]): string =>
  csv(
    [
      "signal_family",
      "signal_type",
      "signal_value",
      "description",
      "count",
      "percentage_of_submission_attempts",
      "percentage_of_processed_sites",
      "success_site_count",
      "inconclusive_site_count",
      "partial_site_count",
      "failed_site_count",
      "other_site_count",
      "site_ids",
    ],
    items.map((item) => [
      item.signalFamily,
      item.signalType,
      item.signalValue,
      item.description,
      item.count,
      item.percentageOfSubmissionAttempts,
      item.percentageOfProcessedSites,
      item.statusCounts.SUCCESS,
      item.statusCounts.INCONCLUSIVE,
      item.statusCounts.PARTIAL,
      item.statusCounts.FAILED,
      item.statusCounts.OTHER,
      item.siteIds,
    ]),
  );

const renderFormSignalSection = (
  title: string,
  items: FormSignalStatistic[],
): string[] => {
  const lines = [title];
  if (items.length === 0) return [...lines, "  none"];
  for (const item of items) {
    lines.push(
      `  ${item.signalFamily} | ${item.signalType} | ${item.signalValue}: ${item.count}` +
        ` (${formatPercent(item.percentageOfSubmissionAttempts)} of attempts;` +
        ` ${formatPercent(item.percentageOfProcessedSites)} of processed)` +
        ` [SUCCESS ${item.statusCounts.SUCCESS}; INCONCLUSIVE ${item.statusCounts.INCONCLUSIVE};` +
        ` LEGACY PARTIAL ${item.statusCounts.PARTIAL};` +
        ` FAILED ${item.statusCounts.FAILED}; OTHER ${item.statusCounts.OTHER}]`,
    );
    lines.push(`    Meaning: ${item.description}`);
    lines.push(`    Sites: ${siteList(item.siteIds)}`);
  }
  return lines;
};

const renderFormSignalText = (result: FormSignalStatistics): string => {
  const lines = [
    "FORM SUBMISSION SIGNAL STATISTICS",
    "=================================",
    `Signal rulebook version: ${result.rulebookVersion}`,
    "Signal rows are multi-label; percentages and row counts are not expected to sum to 100%.",
    "Neutral or missing evidence is not classified as negative.",
    "",
    "DENOMINATORS AND POLARITY",
    `Processed sites: ${result.processedSites.count}`,
    `Submission-attempted sites: ${result.submissionAttemptedSites.count}`,
    `Sites with any positive signal: ${result.sitesWithAnyPositiveSignal.count}`,
    `Sites with any negative signal: ${result.sitesWithAnyNegativeSignal.count}`,
    `Sites with both polarities: ${result.sitesWithBothPolarities.count}`,
    "",
    "ARITHMETIC CLASSIFICATION",
    `  Evaluated: ${result.arithmetic.evaluated.count}`,
    `  Not evaluated: ${result.arithmetic.notEvaluated.count}`,
    `  Malformed: ${result.arithmetic.malformed.count}`,
    `  Success: ${result.arithmetic.classifications.success.count}`,
    `  Failure: ${result.arithmetic.classifications.failure.count}`,
    `  Inconclusive: ${result.arithmetic.classifications.inconclusive.count}`,
    `  Workflow rulebook versions: ${result.arithmetic.observedWorkflowRulebookVersions.join(", ") || "none"}`,
    `  Score distribution: ${result.arithmetic.scoreDistribution.map((item) => `${item.score}=${item.count}`).join(", ") || "none"}`,
    "",
    ...renderFormSignalSection("POSITIVE SIGNALS", result.positive),
    "",
    ...renderFormSignalSection("NEGATIVE SIGNALS", result.negative),
    "",
    "POST-CLICK DISPOSITIONS (CONTEXT ONLY)",
    `  confirmed: ${result.dispositions.confirmed.count}`,
    `  rejected: ${result.dispositions.rejected.count}`,
    `  contradictory: ${result.dispositions.contradictory.count}`,
    `  captchaBlocked: ${result.dispositions.captchaBlocked.count}`,
    `  unconfirmed: ${result.dispositions.unconfirmed.count}`,
    `  missing: ${result.dispositions.missing.count}`,
    `  other: ${result.dispositions.other.count}`,
    "",
    "NEUTRAL NETWORK OBSERVATIONS",
    ...Object.entries(result.neutralNetworkObservations).map(
      ([name, group]) => `  ${name}: ${group.count} [${siteList(group.siteIds)}]`,
    ),
    "",
    "ARTIFACT COVERAGE",
    `  Structured SUBMISSION sections: ${result.coverage.primarySubmissionSections.count}`,
    `  Structured NETWORK sections: ${result.coverage.primaryNetworkSections.count}`,
    `  Debug paths reported: ${result.coverage.debugPathsReported.count}`,
    `  Debug artifacts available: ${result.coverage.debugArtifactsAvailable.count}`,
    `  Confirmation event files available: ${result.coverage.confirmationEventsAvailable.count}`,
    `  Sites enriched with exact messages: ${result.coverage.messageEnrichedSites.count}`,
    `  Malformed debug artifacts: ${result.coverage.malformedDebugArtifacts.count}`,
    `  Unsafe debug paths ignored directly: ${result.coverage.unsafeDebugPaths.count}`,
    `  Complete arithmetic outputs: ${result.coverage.arithmeticCompleteSites.count}`,
    `  Malformed arithmetic outputs: ${result.coverage.arithmeticMalformedSites.count}`,
    `  Legacy inferred sites: ${result.coverage.legacyInferredSites.count}`,
    "",
    "RECONCILIATION",
    `  Statistic counts equal unique site IDs: ${result.reconciliation.statisticCountsMatchUniqueSites ? "yes" : "NO"}`,
    `  Status splits equal statistic counts: ${result.reconciliation.statusCountsMatchStatisticCounts ? "yes" : "NO"}`,
    `  Signal sites belong to processed sites: ${result.reconciliation.signalSitesAreProcessed ? "yes" : "NO"}`,
    `  Polarity site counts equal their unions: ${result.reconciliation.polaritySiteCountsMatchUnions ? "yes" : "NO"}`,
    `  Arithmetic ledger sums reconcile: ${result.reconciliation.arithmeticLedgerSumsMatch ? "yes" : "NO"}`,
    `  Arithmetic statuses reconcile: ${result.reconciliation.arithmeticStatusesMatch ? "yes" : "NO"}`,
    `  Arithmetic polarities reconcile: ${result.reconciliation.arithmeticPolaritiesMatch ? "yes" : "NO"}`,
    `  Arithmetic result labels reconcile: ${result.reconciliation.arithmeticResultLabelsMatch ? "yes" : "NO"}`,
    `  Reported unknown counts reconcile: ${result.reconciliation.reportedUnknownCountsMatch ? "yes" : "NO"}`,
    `  Data-quality warnings: ${result.dataQualityWarnings.length}`,
    ...result.dataQualityWarnings.map((warning) => `    - ${warning}`),
  ];
  return `${lines.join("\r\n")}\r\n`;
};

const discoveryFiles = (
  result: DiscoveryChannelAnalyticsResult,
): OutputFiles => ({
  "channel-statistics.txt": renderDiscoveryText(result),
  "channel-statistics.json": `${JSON.stringify(result, null, 2)}\n`,
  "outcome-statistics.csv": discoveryOutcomeCsv(result),
  "site-classifications.csv": discoverySiteCsv(result),
  "channel-outcomes.svg": renderDiscoveryChannelSvg(result),
  "rulebook.json": `${JSON.stringify(discoveryChannelRulebook(result.channel), null, 2)}\n`,
});

const prefixedFiles = (prefix: string, files: OutputFiles): OutputFiles =>
  Object.fromEntries(Object.entries(files).map(([name, value]) => [path.join(prefix, name), value]));

const outputFiles = async (result: OutreachAnalyticsResult): Promise<OutputFiles> => {
  const forms = result.channels.forms;
  const qualitativeMermaidSvg = await renderMermaidSvg(forms);
  const signalDashboardHtml = renderSignalDashboardHtml(forms);
  const signalDashboardPng = await renderSignalDashboardPng(signalDashboardHtml);
  const formFiles = {
    "qualitative-statistics.txt": renderTextReport(forms, true),
    "qualitative-statistics-compact.txt": renderTextReport(forms, false),
    "qualitative-statistics-mermaid.md": renderMermaidReport(forms),
    "qualitative-statistics-mermaid.svg": qualitativeMermaidSvg,
    "qualitative-statistics-proportional.svg": renderProportionalFunnelSvg(forms),
    "qualitative-statistics.json": `${JSON.stringify(forms, null, 2)}\n`,
    "stage-statistics.csv": stageCsv(forms),
    "site-classifications.csv": siteCsv(forms.sites),
    "rulebook.json": `${JSON.stringify(serializedRulebook, null, 2)}\n`,
    [path.join("signals", "positive-signal-statistics.csv")]: formSignalCsv(
      forms.signalStatistics.positive,
    ),
    [path.join("signals", "negative-signal-statistics.csv")]: formSignalCsv(
      forms.signalStatistics.negative,
    ),
    [path.join("signals", "signal-statistics.txt")]: renderFormSignalText(
      forms.signalStatistics,
    ),
    [path.join("signals", "signal-statistics.json")]:
      `${JSON.stringify(forms.signalStatistics, null, 2)}\n`,
    [path.join("signals", "site-signal-scores.csv")]: csv(
      [
        "site_id", "status", "evaluation", "classification", "display_result", "total_score",
        "retained_score_sum", "retained_signal_count", "suppressed_signal_count", "rulebook_version",
        "arithmetic_reconciles", "status_reconciles", "polarity_reconciles",
        "result_label_reconciles", "unknown_count_reconciles",
      ],
      forms.signalStatistics.arithmetic.sites.map((site) => [
        site.siteId, site.status, site.evaluation, site.classification, site.displayResult,
        site.totalScore ?? "", site.retainedScoreSum, site.retainedSignalCount,
        site.suppressedSignalCount, site.rulebookVersion, site.arithmeticReconciles,
        site.statusReconciles, site.polarityReconciles, site.resultLabelReconciles,
        site.unknownCountReconciles,
      ]),
    ),
    [path.join("signals", "undefined-signal-statistics.json")]:
      `${JSON.stringify(forms.signalStatistics.undefinedSignals, null, 2)}\n`,
    [path.join("signals", "undefined-signal-statistics.csv")]: csv(
      ["kind", "fingerprint", "summary", "reason", "count", "modes", "site_ids"],
      forms.signalStatistics.undefinedSignals.map((item) => [
        item.kind, item.fingerprint, item.summary, item.reason, item.count,
        item.modes.join(";"), item.siteIds.join(";"),
      ]),
    ),
    [path.join("signals", "undefined-signal-statistics.txt")]: [
      "UNDEFINED SUBMISSION SIGNALS",
      "============================",
      `Unique signals: ${forms.signalStatistics.undefinedSignals.length}`,
      "",
      ...forms.signalStatistics.undefinedSignals.map((item) =>
        `${item.count} site(s) | ${item.kind} | ${item.fingerprint} | ${item.summary} | ${item.reason} | sites=${item.siteIds.join(",")}`,
      ),
      "",
    ].join("\r\n"),
    [path.join("signals", "signal-dashboard.html")]: signalDashboardHtml,
    [path.join("signals", "signal-dashboard.png")]: signalDashboardPng,
  };
  return {
    "outreach-statistics.txt": renderOutreachText(result),
    "outreach-statistics.json": `${JSON.stringify(result, null, 2)}\n`,
    "site-channel-matrix.csv": siteChannelMatrixCsv(result),
    "errors.csv": errorsCsv(result.errors),
    ...prefixedFiles(path.join("channels", "forms"), formFiles),
    ...prefixedFiles(path.join("channels", "emails"), discoveryFiles(result.channels.emails)),
    ...prefixedFiles(path.join("channels", "meetings"), discoveryFiles(result.channels.meetings)),
  };
};

const exists = async (targetPath: string): Promise<boolean> => {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

const renameWithWindowsRetry = async (source: string, destination: string): Promise<void> => {
  const maximumAttempts = 6;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (!(code === "EPERM" || code === "EBUSY" || code === "EACCES") || attempt === maximumAttempts) throw error;
      await delay(attempt * 100);
    }
  }
};

const timestampName = (date: Date): string => date.toISOString().replace(/[:.]/g, "-");

const uniqueHistoryDirectory = async (historyRoot: string, timestamp: string): Promise<string> => {
  let candidate = path.join(historyRoot, timestamp);
  let suffix = 1;
  while (await exists(candidate)) {
    candidate = path.join(historyRoot, `${timestamp}_${suffix}`);
    suffix += 1;
  }
  return candidate;
};

const writeDirectory = async (directory: string, files: OutputFiles): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await Promise.all(
    Object.entries(files).map(async ([fileName, value]) => {
      const outputPath = path.join(directory, fileName);
      await mkdir(path.dirname(outputPath), { recursive: true });
      if (typeof value === "string") await writeFile(outputPath, value, "utf8");
      else await writeFile(outputPath, value);
    }),
  );
};

const publishLatestAtomically = async (
  analyticsRoot: string,
  files: OutputFiles,
  timestamp: string,
): Promise<string> => {
  const latest = path.join(analyticsRoot, "latest");
  const operationId = randomUUID();
  const temporary = path.join(analyticsRoot, `.latest-${timestamp}-${operationId}-tmp`);
  const backup = path.join(analyticsRoot, `.latest-${timestamp}-${operationId}-backup`);
  await writeDirectory(temporary, files);
  let movedOldLatest = false;
  try {
    if (await exists(latest)) {
      await renameWithWindowsRetry(latest, backup);
      movedOldLatest = true;
    }
    await renameWithWindowsRetry(temporary, latest);
    if (movedOldLatest) await rm(backup, { recursive: true, force: true });
    return latest;
  } catch (error) {
    if (!(await exists(latest)) && movedOldLatest && (await exists(backup))) await renameWithWindowsRetry(backup, latest);
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
};

export const writeAnalyticsOutputs = async (
  result: OutreachAnalyticsResult,
): Promise<{ historyDirectory: string; latestDirectory?: string; latestWarning?: string }> => {
  const analyticsRoot = path.join(result.runPath, "analytics");
  const historyRoot = path.join(analyticsRoot, "history");
  await mkdir(historyRoot, { recursive: true });
  const timestamp = timestampName(new Date(result.generatedAt));
  const historyDirectory = await uniqueHistoryDirectory(historyRoot, timestamp);
  const files = await outputFiles(result);
  const historyTemporary = `${historyDirectory}.${randomUUID()}.tmp`;
  try {
    await writeDirectory(historyTemporary, files);
    await renameWithWindowsRetry(historyTemporary, historyDirectory);
  } catch (error) {
    await rm(historyTemporary, { recursive: true, force: true });
    throw new Error(`Failed to publish timestamped analytics history atomically: ${String(error)}`);
  }
  try {
    const latestDirectory = await publishLatestAtomically(analyticsRoot, files, timestamp);
    return { historyDirectory, latestDirectory };
  } catch (error) {
    return {
      historyDirectory,
      latestWarning:
        `Timestamped analytics were published successfully, but analytics/latest could not be refreshed: ${String(error)}`,
    };
  }
};
