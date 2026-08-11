import path from "node:path";
import type {
  AnalyticsCounts,
  AnalyzeOptions,
  AnalyzeOutcome,
  Attribution,
  AttributionStatistics,
  CountAndSites,
  FormAnalyticsResult,
  OutreachAnalyticsResult,
  ReconciliationResult,
  SiteClassification,
  StageStatistics,
  TerminalStage,
} from "./analytics_types.js";
import { ANALYTICS_SCHEMA_VERSION, FORM_RULEBOOK_VERSION, STAGES } from "./analytics_types.js";
import { readRunArtifacts } from "./artifact_reader.js";
import { analyzeDiscoveryChannel } from "./discovery_channel_analyzer.js";
import { classifySite } from "./rulebook.js";
import { writeAnalyticsOutputs } from "./report_writer.js";
import { analyzeFormSubmissionSignals } from "./submission_signal_analyzer.js";

const percentage = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(2));

const countAndSites = (sites: SiteClassification[]): CountAndSites => ({
  count: sites.length,
  siteIds: sites.map((site) => site.id),
});

const buildStageStatistics = (stage: TerminalStage, sites: SiteClassification[]): StageStatistics => {
  const notApplicable = sites.filter((site) => site.stageStates[stage] === "not_applicable");
  const entrants = sites.filter((site) =>
    ["entered", "advanced", "qualified_not_executed", "completed", "stopped", "incomplete"].includes(
      site.stageStates[stage],
    ),
  );
  const advanced = entrants.filter((site) =>
    ["advanced", "qualified_not_executed", "completed"].includes(site.stageStates[stage]),
  );
  const stopped = entrants.filter((site) => site.stageStates[stage] === "stopped");
  const incomplete = entrants.filter((site) => site.stageStates[stage] === "incomplete");
  const terminal = sites.filter((site) => site.terminalStage === stage && site.runState !== "incomplete");
  const attributions: Attribution[] = [
    "workflow_attributable",
    "non_workflow_attributable",
    "indeterminate",
    "not_applicable",
  ];
  const attribution = Object.fromEntries(
    attributions.map((value) => [value, countAndSites(terminal.filter((site) => site.attribution === value))]),
  ) as Record<Attribution, CountAndSites>;

  const groups = new Map<string, SiteClassification[]>();
  for (const site of terminal) {
    const key = `${site.attribution}\u0000${site.causeFamily}\u0000${site.subcategory}`;
    const existing = groups.get(key) ?? [];
    existing.push(site);
    groups.set(key, existing);
  }
  const subcategories = [...groups.entries()]
    .map(([key, values]) => {
      const [attributionValue, causeFamily, subcategory] = key.split("\u0000");
      if (!attributionValue || !causeFamily || !subcategory) throw new Error("Invalid internal subcategory key.");
      return {
        attribution: attributionValue as Attribution,
        causeFamily: causeFamily as SiteClassification["causeFamily"],
        subcategory,
        ...countAndSites(values),
      };
    })
    .sort((left, right) => right.count - left.count || left.subcategory.localeCompare(right.subcategory));

  return {
    stage,
    applicable: sites.length - notApplicable.length,
    entered: entrants.length,
    advancedOrQualifiedOrCompleted: advanced.length,
    stopped: stopped.length,
    incomplete: incomplete.length,
    notApplicable: notApplicable.length,
    advanceRateAmongEntrants: percentage(advanced.length, entrants.length),
    stopRateAmongEntrants: percentage(stopped.length, entrants.length),
    attribution,
    subcategories,
  };
};

const buildCounts = (sites: SiteClassification[], plannedCount: number | null): AnalyticsCounts => {
  const completed = sites.filter((site) => site.runState === "completed").length;
  const qualified = sites.filter((site) => site.runState === "qualified").length;
  const stopped = sites.filter((site) => site.runState === "stopped").length;
  const incomplete = sites.filter((site) => site.runState === "incomplete").length;
  return {
    planned: plannedCount,
    processed: sites.length,
    completed,
    qualified,
    stopped,
    incomplete,
    notStarted: plannedCount === null ? null : Math.max(0, plannedCount - sites.length),
    terminalResults: completed + qualified + stopped,
  };
};

const buildFinalAttribution = (
  sites: SiteClassification[],
  counts: AnalyticsCounts,
): FormAnalyticsResult["finalAttribution"] => {
  const values: Array<Exclude<Attribution, "not_applicable">> = [
    "workflow_attributable",
    "non_workflow_attributable",
    "indeterminate",
  ];
  return Object.fromEntries(
    values.map((value) => {
      const matching = sites.filter((site) => site.runState === "stopped" && site.attribution === value);
      const result: AttributionStatistics = {
        ...countAndSites(matching),
        percentageOfStopped: percentage(matching.length, counts.stopped),
        percentageOfCompletedSites: percentage(matching.length, counts.terminalResults),
      };
      return [value, result];
    }),
  ) as FormAnalyticsResult["finalAttribution"];
};

const reconcile = (
  sites: SiteClassification[],
  counts: AnalyticsCounts,
  stages: StageStatistics[],
): ReconciliationResult => {
  const processedStateTotal = counts.completed + counts.qualified + counts.stopped + counts.incomplete;
  const attributionTotal =
    sites.filter((site) => site.runState === "stopped" && site.attribution === "workflow_attributable").length +
    sites.filter((site) => site.runState === "stopped" && site.attribution === "non_workflow_attributable").length +
    sites.filter((site) => site.runState === "stopped" && site.attribution === "indeterminate").length;
  const uniqueSiteClassifications = new Set(sites.map((site) => site.id)).size === sites.length;
  const stageSubcategoriesDoNotDoubleCount = stages.every((stage) => {
    const ids = stage.subcategories.flatMap((category) => category.siteIds);
    return ids.length === new Set(ids).size;
  });
  return {
    processedEqualsStates: counts.processed === processedStateTotal,
    processedStateTotal,
    stoppedEqualsAttributions: counts.stopped === attributionTotal,
    attributionTotal,
    uniqueSiteClassifications,
    stageSubcategoriesDoNotDoubleCount,
  };
};

export const analyzeRun = async (requestedPath: string, options: AnalyzeOptions = {}): Promise<AnalyzeOutcome> => {
  const artifacts = await readRunArtifacts(requestedPath);
  const sites = artifacts.sites.map(classifySite).sort((left, right) => left.numericId - right.numericId);
  const counts = buildCounts(sites, artifacts.plannedCount);
  const stages = STAGES.map((stage) => buildStageStatistics(stage, sites));
  const reconciliation = reconcile(sites, counts, stages);
  const signalStatistics = analyzeFormSubmissionSignals(artifacts.sites);
  const dataQualityWarnings = [...artifacts.warnings, ...signalStatistics.dataQualityWarnings];
  if (!reconciliation.processedEqualsStates) dataQualityWarnings.push("Processed-site state totals do not reconcile.");
  if (!reconciliation.stoppedEqualsAttributions) dataQualityWarnings.push("Stopped-site attribution totals do not reconcile.");
  if (!reconciliation.uniqueSiteClassifications) dataQualityWarnings.push("Duplicate site IDs were classified.");
  if (!reconciliation.stageSubcategoriesDoNotDoubleCount) {
    dataQualityWarnings.push("At least one stage contains a site in more than one primary subcategory.");
  }
  if (!signalStatistics.reconciliation.statisticCountsMatchUniqueSites) {
    dataQualityWarnings.push("At least one form signal statistic contains duplicate site IDs.");
  }
  if (!signalStatistics.reconciliation.statusCountsMatchStatisticCounts) {
    dataQualityWarnings.push("At least one form signal status split does not reconcile with its count.");
  }
  if (!signalStatistics.reconciliation.signalSitesAreProcessed) {
    dataQualityWarnings.push("At least one form signal references a site outside the processed set.");
  }
  if (!signalStatistics.reconciliation.polaritySiteCountsMatchUnions) {
    dataQualityWarnings.push("Form signal polarity site unions do not reconcile.");
  }
  if (!signalStatistics.reconciliation.arithmeticLedgerSumsMatch) {
    dataQualityWarnings.push("At least one arithmetic signal score does not equal its retained ledger sum.");
  }
  if (!signalStatistics.reconciliation.arithmeticStatusesMatch) {
    dataQualityWarnings.push("At least one arithmetic signal classification does not match its forms status.");
  }
  if (!signalStatistics.reconciliation.arithmeticPolaritiesMatch) {
    dataQualityWarnings.push("At least one arithmetic signal polarity flag does not match its retained ledger.");
  }
  if (!signalStatistics.reconciliation.arithmeticResultLabelsMatch) {
    dataQualityWarnings.push("At least one arithmetic signal display result does not match its score.");
  }
  if (!signalStatistics.reconciliation.reportedUnknownCountsMatch) {
    dataQualityWarnings.push("At least one reported unknown-signal count does not match parsed unknown rows.");
  }

  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const forms: FormAnalyticsResult = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    rulebookVersion: FORM_RULEBOOK_VERSION,
    generatedAt,
    runPath: path.resolve(requestedPath),
    runMode: artifacts.mode,
    counts,
    finalAttribution: buildFinalAttribution(sites, counts),
    signalStatistics,
    stages,
    sites,
    errors: artifacts.errors,
    dataQualityWarnings: [...dataQualityWarnings],
    reconciliation,
  };
  const emails = analyzeDiscoveryChannel(
    "emails",
    artifacts.sites,
    artifacts.plannedCount,
    artifacts.runPath,
    generatedAt,
  );
  const meetings = analyzeDiscoveryChannel(
    "meetings",
    artifacts.sites,
    artifacts.plannedCount,
    artifacts.runPath,
    generatedAt,
  );
  const evidenceIds = artifacts.sites.map((site) => site.id);
  const formIds = forms.sites.map((site) => site.id);
  const emailIds = emails.sites.map((site) => site.id);
  const meetingIds = meetings.sites.map((site) => site.id);
  const outreachWarnings = [...dataQualityWarnings];
  for (const channel of [emails, meetings]) {
    if (!channel.reconciliation.oneClassificationPerSite) {
      outreachWarnings.push(`${channel.channel} contains duplicate site classifications.`);
    }
    if (!channel.reconciliation.processedEqualsOutcomeTotal) {
      outreachWarnings.push(`${channel.channel} processed and normalized-outcome counts do not reconcile.`);
    }
    if (!channel.reconciliation.itemCountsMatchParsedItems) {
      outreachWarnings.push(`${channel.channel} contains reported item counts that do not match parsed item lines.`);
    }
    if (!channel.reconciliation.coverageCountsReconcile) {
      outreachWarnings.push(`${channel.channel} complete and incomplete coverage counts do not reconcile.`);
    }
  }
  const sameIds = (left: string[], right: string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  const result: OutreachAnalyticsResult = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generatedAt,
    runPath: artifacts.runPath,
    runMode: artifacts.mode,
    planned: artifacts.plannedCount,
    processed: artifacts.sites.length,
    notStarted:
      artifacts.plannedCount === null ? null : Math.max(0, artifacts.plannedCount - artifacts.sites.length),
    channels: { forms, emails, meetings },
    errors: artifacts.errors,
    dataQualityWarnings: outreachWarnings,
    reconciliation: {
      uniqueSiteEvidence: new Set(evidenceIds).size === evidenceIds.length,
      allChannelsClassifyEverySite:
        formIds.length === evidenceIds.length &&
        emailIds.length === evidenceIds.length &&
        meetingIds.length === evidenceIds.length,
      channelSiteIdsAlign:
        sameIds(evidenceIds, formIds) && sameIds(evidenceIds, emailIds) && sameIds(evidenceIds, meetingIds),
      plannedCountIsNotBelowProcessed:
        artifacts.plannedCount === null || artifacts.plannedCount >= artifacts.sites.length,
    },
  };

  if (options.writeOutputs === false) return { result };
  const output = await writeAnalyticsOutputs(result);
  if (output.latestWarning) result.dataQualityWarnings.push(output.latestWarning);
  return { result, ...output };
};
