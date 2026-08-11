import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AnalyticsError,
  BrowserStageArtifactEvidence,
  DiscoveryChannelEvidence,
  DiscoveryChannelName,
  FormConfirmationEvidence,
  FormArithmeticSignalEvidence,
  FormMessageSignalEvidence,
  FormRejectionCategory,
  FormSubmissionSignalEvidence,
  NetworkRequestEvidence,
  SiteEvidence,
  SiteWorkflowMode,
  WorkflowMode,
} from "./analytics_types.js";

const MAX_TEXT_BYTES = 1_000_000;
const DEBUG_FILES = ["discovery-debug.json", "submission-debug.json", "missing-fields.json", "network.json"];

interface JsonObject {
  [key: string]: unknown;
}

export interface RunArtifacts {
  runPath: string;
  mode: WorkflowMode;
  plannedCount: number | null;
  sites: SiteEvidence[];
  errors: AnalyticsError[];
  warnings: string[];
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const booleanValue = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const numberValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

const readTextSafe = async (filePath: string): Promise<string> => {
  try {
    const value = await readFile(filePath, "utf8");
    return value.length > MAX_TEXT_BYTES ? value.slice(0, MAX_TEXT_BYTES) : value;
  } catch {
    return "";
  }
};

const parseJsonText = (value: string): unknown => JSON.parse(value.replace(/^\uFEFF/, "")) as unknown;

const parseField = (report: string, label: string): string => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = report.match(new RegExp(`^${escaped}:\\s*(.*)$`, "im"));
  return match?.[1]?.trim() ?? "";
};

const parseRepeatedField = (report: string, label: string): string[] => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...report.matchAll(new RegExp(`^${escaped}:\\s*(.*)$`, "gim"))]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
};

const splitSections = (report: string): Map<string, string> => {
  const sections = new Map<string, string>();
  let current = "";
  let lines: string[] = [];
  const flush = (): void => {
    if (current) sections.set(current, lines.join("\n").trim());
  };
  for (const line of report.split(/\r?\n/)) {
    const heading = line.match(/^=+\s+(.+?)\s+=+$/);
    if (heading?.[1]) {
      flush();
      current = heading[1].trim().toUpperCase();
      lines = [];
    } else if (current) {
      lines.push(line);
    }
  }
  flush();
  return sections;
};

const parseYesNo = (value: string): boolean | undefined => {
  if (/^(?:yes|true)$/i.test(value)) return true;
  if (/^(?:no|false)$/i.test(value)) return false;
  return undefined;
};

const parseBrowserStageSection = (section: string): BrowserStageArtifactEvidence | undefined => {
  if (!section) return undefined;
  const duration = Number(parseField(section, "Duration (ms)"));
  const timeout = Number(parseField(section, "Navigation timeout (ms)"));
  const statusText = parseField(section, "Main document status");
  const status = /^\d+$/.test(statusText) ? Number.parseInt(statusText, 10) : null;
  const outcome = parseField(section, "Outcome");
  const category = parseField(section, "Classification");
  return {
    entered: parseYesNo(parseField(section, "Entered")) ?? false,
    outcome: ["LOADED", "LOADED_AFTER_TIMEOUT", "FAILED", "NOT_ENTERED"].includes(outcome)
      ? outcome as BrowserStageArtifactEvidence["outcome"]
      : "",
    phase: parseField(section, "Phase"),
    operation: parseField(section, "Operation"),
    originalUrl: parseField(section, "Original URL"),
    finalUrl: parseField(section, "Final URL"),
    durationMs: Number.isFinite(duration) ? duration : null,
    timeoutMs: Number.isFinite(timeout) ? timeout : null,
    waitUntil: parseField(section, "Wait until"),
    mainDocumentRequested: parseYesNo(parseField(section, "Main document requested")),
    mainDocumentReceived: parseYesNo(parseField(section, "Main document received")),
    mainDocumentStatus: status,
    meaningfulContent: parseYesNo(parseField(section, "Meaningful content present")),
    browserConnected: parseYesNo(parseField(section, "Browser connected")),
    pageClosed: parseYesNo(parseField(section, "Page closed")),
    category: ["OUR_SYSTEM_FAILURE", "DESTINATION_FAILURE", "ACCESS_RESTRICTION", "UNDETERMINED"].includes(category)
      ? category as BrowserStageArtifactEvidence["category"]
      : "",
    responsibleParty: parseField(section, "Responsible party"),
    subcategory: parseField(section, "Subcategory"),
    confidence: parseField(section, "Confidence"),
    ruleId: parseField(section, "Classification rule"),
    reason: parseField(section, "Browser-stage reason"),
    artifactPath: parseField(section, "Browser-stage artifact"),
    source: "structured_text",
  };
};

const browserStageFromJson = (value: unknown): BrowserStageArtifactEvidence | undefined => {
  if (!isObject(value) || value.schemaVersion !== 1) return undefined;
  const content = isObject(value.content) ? value.content : {};
  const health = isObject(value.health) ? value.health : {};
  const outcome = stringValue(value.outcome);
  const category = stringValue(value.category);
  return {
    entered: Boolean(value.entered),
    outcome: ["LOADED", "LOADED_AFTER_TIMEOUT", "FAILED", "NOT_ENTERED"].includes(outcome)
      ? outcome as BrowserStageArtifactEvidence["outcome"]
      : "",
    phase: stringValue(value.phase),
    operation: stringValue(value.operation),
    originalUrl: stringValue(value.originalUrl),
    finalUrl: stringValue(value.finalUrl),
    durationMs: typeof value.durationMs === "number" && Number.isFinite(value.durationMs) ? value.durationMs : null,
    timeoutMs: numberValue(value.timeoutMs),
    waitUntil: stringValue(value.waitUntil),
    mainDocumentRequested: booleanValue(value.mainDocumentRequested),
    mainDocumentReceived: booleanValue(value.mainDocumentReceived),
    mainDocumentStatus: numberValue(value.mainDocumentStatus),
    meaningfulContent: booleanValue(content.meaningfulContent),
    browserConnected: booleanValue(health.browserConnected),
    pageClosed: booleanValue(health.pageClosed),
    category: ["OUR_SYSTEM_FAILURE", "DESTINATION_FAILURE", "ACCESS_RESTRICTION", "UNDETERMINED"].includes(category)
      ? category as BrowserStageArtifactEvidence["category"]
      : "",
    responsibleParty: stringValue(value.responsibleParty),
    subcategory: stringValue(value.subcategory),
    confidence: stringValue(value.confidence),
    ruleId: stringValue(value.ruleId),
    reason: stringValue(value.reason),
    artifactPath: stringValue(value.diagnosticArtifactPath),
    source: "debug_artifact",
  };
};

const parseInteger = (value: string): number | null =>
  /^-?\d+$/.test(value.trim()) ? Number.parseInt(value.trim(), 10) : null;

const emptyArithmeticEvidence = (): FormArithmeticSignalEvidence => ({
  presence: "absent",
  evaluation: "unknown",
  displayResult: "",
  classification: "unknown",
  totalScore: null,
  rulebookVersion: "",
  ledger: [],
  reportedUnknownCount: null,
  parseErrors: [],
});

const parseArithmeticEvidence = (submission: string): FormArithmeticSignalEvidence => {
  const evaluationText = parseField(submission, "Signal evaluation").toLowerCase();
  const displayResult = parseField(submission, "Signal result");
  const scoreText = parseField(submission, "Signal score");
  const rulebookVersion = parseField(submission, "Signal rulebook version");
  const polarityText = parseField(submission, "Signal polarities");
  const unknownCountText = parseField(submission, "Unknown signal count");
  const signalLines = parseRepeatedField(submission, "Signal");
  const hasMarkers = Boolean(
    evaluationText || displayResult || scoreText || rulebookVersion || polarityText || signalLines.length,
  );
  if (!hasMarkers) return emptyArithmeticEvidence();

  const parseErrors: string[] = [];
  const evaluation = evaluationText === "evaluated"
    ? "evaluated"
    : evaluationText === "not evaluated"
      ? "not_evaluated"
      : "unknown";
  if (evaluation === "unknown") parseErrors.push("Signal evaluation is missing or unsupported.");

  const totalScore = scoreText ? parseInteger(scoreText) : null;
  const resultMatch = /^(Success|Failure)\s+(-?\d+)$|^(Inconclusive)$/i.exec(displayResult);
  const classification = resultMatch?.[1]?.toLowerCase() === "success"
    ? "success"
    : resultMatch?.[1]?.toLowerCase() === "failure"
      ? "failure"
      : resultMatch?.[3]
        ? "inconclusive"
        : "unknown";
  if (evaluation === "evaluated") {
    if (totalScore === null) parseErrors.push("Evaluated signal output lacks an integer score.");
    if (classification === "unknown") parseErrors.push("Evaluated signal output lacks a valid result label.");
    if (!rulebookVersion) parseErrors.push("Evaluated signal output lacks a rulebook version.");
  }

  const polarityMatch = /^positive=(yes|no),\s*negative=(yes|no),\s*both=(yes|no)$/i.exec(polarityText);
  if (evaluation === "evaluated" && !polarityMatch) {
    parseErrors.push("Evaluated signal output lacks valid polarity flags.");
  }
  const ledger = signalLines.flatMap((line) => {
    const match = /^(retained|suppressed)\s*\|\s*([^|]+?)\s*\|\s*([+-]?\d+)\s*\|\s*(.*)$/i.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) {
      parseErrors.push(`Malformed signal ledger row: ${line.slice(0, 160)}`);
      return [];
    }
    const identity = match[2].trim();
    const slash = identity.indexOf("/");
    const tail = match[4] ?? "";
    const suppression = /^(.*?)(?:\s+\|\s+(Suppressed by .*))$/i.exec(tail);
    return [{
      state: match[1].toLowerCase() as "retained" | "suppressed",
      signalId: slash < 0 ? identity : identity.slice(0, slash),
      variantId: slash < 0 ? "" : identity.slice(slash + 1),
      score: Number.parseInt(match[3], 10),
      evidenceSummary: (suppression?.[1] ?? tail).trim(),
      suppressionReason: (suppression?.[2] ?? "").trim(),
    }];
  });
  const reportedUnknownCount = unknownCountText ? parseInteger(unknownCountText) : null;
  if (unknownCountText && (reportedUnknownCount === null || reportedUnknownCount < 0)) {
    parseErrors.push("Unknown signal count is not a non-negative integer.");
  }
  return {
    presence: parseErrors.length ? "malformed" : "complete",
    evaluation,
    displayResult,
    classification,
    totalScore,
    rulebookVersion,
    ...(polarityMatch
      ? {
          hasPositiveSignals: polarityMatch[1]?.toLowerCase() === "yes",
          hasNegativeSignals: polarityMatch[2]?.toLowerCase() === "yes",
          hasBothPolarities: polarityMatch[3]?.toLowerCase() === "yes",
        }
      : {}),
    ledger,
    reportedUnknownCount,
    parseErrors,
  };
};

const normalizeConfirmationEvidence = (value: string): FormConfirmationEvidence => {
  switch (value.trim().toLowerCase()) {
    case "success text":
    case "successtext":
      return "success_text";
    case "success url":
    case "successurl":
      return "success_url";
    case "network":
      return "network";
    case "ai-verified visible text":
    case "aivisibletext":
      return "ai_visible_text";
    case "none":
    case "":
      return "none";
    default:
      return "unknown";
  }
};

const parseRejectionEvidence = (
  value: string,
): { count: number | null; categories: FormRejectionCategory[] } => {
  const match = /^(\d+)\s*\(([^)]*)\)\s*$/.exec(value);
  if (!match?.[1]) return { count: null, categories: [] };
  const supported = new Set<FormRejectionCategory>(["validation", "captcha", "server", "generic"]);
  const categories = (match[2] ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item): item is FormRejectionCategory => supported.has(item as FormRejectionCategory));
  return { count: Number.parseInt(match[1], 10), categories: [...new Set(categories)] };
};

const parseNetworkEvidence = (
  value: string,
): { found?: boolean; confidence: string } => {
  const match = /^(yes|no)\s*\(([^)]*)\)\s*$/i.exec(value);
  if (!match?.[1]) return { confidence: "" };
  return {
    found: match[1].toLowerCase() === "yes",
    confidence: (match[2] ?? "").trim().toLowerCase(),
  };
};

const parseNetworkRequest = (value: string): NetworkRequestEvidence | undefined => {
  const match = /^(POST|PUT|PATCH)\s+(\d+|no-status)\s+(.+)$/i.exec(value.trim());
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    method: match[1].toUpperCase(),
    status: match[2] === "no-status" ? null : Number.parseInt(match[2], 10),
    url: match[3].trim(),
  };
};

const parseNetworkRequestObject = (value: unknown): NetworkRequestEvidence | undefined => {
  if (!isObject(value)) return undefined;
  const method = stringValue(value.method).toUpperCase();
  const url = stringValue(value.url);
  const status =
    typeof value.status === "number" && Number.isInteger(value.status) ? value.status : null;
  if (!["POST", "PUT", "PATCH"].includes(method) || !url) return undefined;
  return { method, status, url };
};

const containedPath = (parent: string, candidate: string): boolean => {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const existingDirectory = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
};

const existingFile = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
};

const resolveDebugDirectory = async (
  siteDirectory: string,
  reportedPath: string,
): Promise<{ directory?: string; unsafe: boolean }> => {
  if (!reportedPath) return { unsafe: false };
  const reported = path.isAbsolute(reportedPath)
    ? path.normalize(reportedPath)
    : path.resolve(siteDirectory, reportedPath);
  const unsafe = !containedPath(siteDirectory, reported);
  const candidates = [
    reported,
    path.join(siteDirectory, "deep-debug", path.basename(reportedPath)),
  ].filter((candidate, index, values) => values.indexOf(candidate) === index);
  for (const candidate of candidates) {
    if (!containedPath(siteDirectory, candidate)) continue;
    if (await existingDirectory(candidate)) return { directory: candidate, unsafe };
  }
  return { unsafe };
};

const normalizeMessageExcerpt = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 500);

const parseMessageCandidateTexts = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (isObject(item) ? normalizeMessageExcerpt(stringValue(item.text)) : ""))
    .filter(Boolean);
};

const parseDebugMessageSignals = (
  raw: string,
): { signals: FormMessageSignalEvidence[]; malformed: boolean } => {
  const signals: FormMessageSignalEvidence[] = [];
  let malformed = false;
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    let event: unknown;
    try {
      event = parseJsonText(line);
    } catch {
      malformed = true;
      continue;
    }
    if (!isObject(event) || stringValue(event.operation) !== "wait-for-submission-confirmation") continue;
    const data = isObject(event.data) ? event.data : null;
    if (!data) continue;
    if (stringValue(data.evidence) === "successText") {
      for (const text of parseMessageCandidateTexts(data.newMessageCandidates)) {
        signals.push({
          polarity: "positive",
          signalType: "visible_success_text",
          category: "confirmation",
          source: "visibleMessage",
          text,
        });
      }
    }
    if (!Array.isArray(data.rejectionEvidence)) continue;
    for (const item of data.rejectionEvidence) {
      if (!isObject(item)) continue;
      const text = normalizeMessageExcerpt(stringValue(item.excerpt));
      if (!text) continue;
      signals.push({
        polarity: "negative",
        signalType: "rejection_message",
        category: stringValue(item.category).toLowerCase(),
        source: stringValue(item.source) || "unknown",
        text,
      });
    }
  }
  const seen = new Set<string>();
  return {
    signals: signals.filter((signal) => {
      const key = [
        signal.polarity,
        signal.signalType,
        signal.category,
        signal.source,
        signal.text.normalize("NFKC").toLowerCase(),
      ].join("\n");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    malformed,
  };
};

const emptySubmissionSignalEvidence = (): FormSubmissionSignalEvidence => ({
  primaryAvailable: false,
  debugPathReported: false,
  debugArtifactAvailable: false,
  confirmationEventsAvailable: false,
  debugArtifactMalformed: false,
  unsafeDebugPath: false,
  confirmationEvidence: "none",
  postClickDisposition: "",
  rejectionEvidenceCount: null,
  rejectionCategories: [],
  networkAvailable: false,
  networkConfidence: "",
  networkProviderRuleId: "",
  networkReason: "",
  messageSignals: [],
  arithmetic: emptyArithmeticEvidence(),
});

const findInputPath = (names: string[]): string | undefined =>
  names.find((name) => /^input-id-.*\.json$/i.test(name));

const findNamedPath = (directory: string, names: string[], expected: string): string | undefined => {
  const found = names.find((name) => name.toLowerCase() === expected.toLowerCase());
  return found ? path.join(directory, found) : undefined;
};

const findWebsiteUrl = (input: unknown): string => {
  if (!isObject(input)) return "";
  const direct = stringValue(input.websiteUrl);
  if (direct) return direct;
  return isObject(input.website) ? stringValue(input.website.websiteUrl) : "";
};

const discoveryJsonValues = (json: unknown): JsonObject | null => {
  if (!isObject(json)) return null;
  return isObject(json.result) ? json.result : json;
};

const compactJsonEvidence = (value: unknown): string[] => {
  if (!isObject(value)) return [];
  const evidence: string[] = [];
  for (const key of ["evidence", "limitations", "rejectedCandidates"] as const) {
    const item = value[key];
    if (item !== undefined) evidence.push(`${key}: ${JSON.stringify(item).slice(0, 20_000)}`);
  }
  return evidence;
};

const makeError = (
  siteId: string,
  severity: AnalyticsError["severity"],
  code: string,
  message: string,
  sourcePath: string,
): AnalyticsError => ({ siteId, severity, code, message, sourcePath });

const parseNonNegativeInteger = (
  section: string,
  label: string,
  malformedFields: string[],
): number | null => {
  const raw = parseField(section, label);
  if (!raw) {
    malformedFields.push(label);
    return null;
  }
  if (!/^\d+$/.test(raw)) {
    malformedFields.push(label);
    return null;
  }
  return Number.parseInt(raw, 10);
};

const emptyDiscoveryEvidence = (): DiscoveryChannelEvidence => ({
  available: false,
  status: "",
  reason: "",
  failureKind: "",
  itemCount: null,
  items: [],
  providers: [],
  plannedPages: null,
  inspectedPages: null,
  failedPages: null,
  malformedFields: [],
});

const parseDiscoveryEvidence = (
  channel: DiscoveryChannelName,
  section: string | undefined,
): DiscoveryChannelEvidence => {
  if (section === undefined) return emptyDiscoveryEvidence();
  const prefix = channel === "emails" ? "Email" : "Meeting";
  const malformedFields: string[] = [];
  const status = parseField(section, `${prefix} status`);
  if (!status) malformedFields.push(`${prefix} status`);
  const itemCount = parseNonNegativeInteger(
    section,
    channel === "emails" ? "Email count" : "Meeting link count",
    malformedFields,
  );
  const rawItems = parseRepeatedField(section, channel === "emails" ? "Discovered email" : "Meeting link");
  const items: string[] = [];
  const providers: string[] = [];
  for (const raw of rawItems) {
    if (channel === "emails") {
      items.push(raw);
      continue;
    }
    const match = raw.match(/^(.*?)\s+\(provider:\s*([^;]+);/i);
    if (match?.[1]) {
      items.push(match[1].trim());
      providers.push(match[2]?.trim().toLowerCase() || "custom");
    } else {
      items.push(raw);
      providers.push("custom");
    }
  }
  return {
    available: true,
    status,
    reason: parseField(section, `${prefix} reason`),
    failureKind: parseField(section, `${prefix} failure kind`),
    itemCount,
    items,
    providers,
    plannedPages: parseNonNegativeInteger(section, `${prefix} planned pages`, malformedFields),
    inspectedPages: parseNonNegativeInteger(section, `${prefix} inspected pages`, malformedFields),
    failedPages: parseNonNegativeInteger(section, `${prefix} failed pages`, malformedFields),
    malformedFields,
  };
};

const formTextFromOutreachSections = (sections: Map<string, string>): string =>
  [...sections.entries()]
    .filter(([name]) => !["CHANNEL SUMMARY", "EMAIL DISCOVERY", "MEETING DISCOVERY"].includes(name))
    .map(([name, value]) => `==================== ${name} ====================\n${value}`)
    .join("\n\n");

const readSite = async (runPath: string, directoryName: string): Promise<SiteEvidence> => {
  const directory = path.join(runPath, directoryName);
  const numericId = Number.parseInt(directoryName, 10);
  const names = await readdir(directory);
  const inputName = findInputPath(names);
  const inputPath = inputName ? path.join(directory, inputName) : undefined;
  const resultPath = findNamedPath(directory, names, "result.txt");
  const deepDebugPath = findNamedPath(directory, names, "deep-debug.txt");
  const outreachPath = resultPath ?? deepDebugPath;
  const productionPath = findNamedPath(directory, names, "production.txt");
  const discoveryTextPath = findNamedPath(directory, names, "discovery.txt");
  const discoveryJsonPath = findNamedPath(directory, names, "discovery-result.json");
  const sourcePaths = [inputPath, resultPath, deepDebugPath, productionPath, discoveryJsonPath, discoveryTextPath].filter(
    (value): value is string => Boolean(value),
  );
  const errors: AnalyticsError[] = [];

  let inputJson: unknown;
  let inputMalformed = false;
  if (inputPath) {
    const inputText = await readTextSafe(inputPath);
    try {
      inputJson = parseJsonText(inputText);
    } catch (error) {
      inputMalformed = true;
      errors.push(makeError(directoryName, "error", "malformed_input_json", String(error), inputPath));
    }
  }

  const outreachText = outreachPath ? await readTextSafe(outreachPath) : "";
  const outreachSections = splitSections(outreachText);
  const outreachFormText = formTextFromOutreachSections(outreachSections);
  const productionText = productionPath ? await readTextSafe(productionPath) : "";
  const productionSections = splitSections(productionText);
  const discoveryText = discoveryTextPath ? await readTextSafe(discoveryTextPath) : "";
  let discoveryResult: JsonObject | null = null;
  let primaryArtifactMalformed = false;
  if (discoveryJsonPath) {
    const raw = await readTextSafe(discoveryJsonPath);
    try {
      discoveryResult = discoveryJsonValues(parseJsonText(raw));
      if (!discoveryResult) throw new Error("discovery-result.json does not contain an object result.");
    } catch (error) {
      primaryArtifactMalformed = true;
      errors.push(makeError(directoryName, "error", "malformed_discovery_result", String(error), discoveryJsonPath));
    }
  }

  const hasFull = Boolean(outreachPath || productionPath);
  const hasDiscovery = Boolean(discoveryJsonPath || discoveryTextPath);
  const primaryTextPath = outreachPath ?? productionPath ?? discoveryTextPath;
  const mode: SiteWorkflowMode =
    hasFull && hasDiscovery ? "conflicting" : hasFull ? "full" : hasDiscovery ? "discovery" : "unknown";
  const conflictingModeEvidence = mode === "conflicting";
  if (conflictingModeEvidence) {
    errors.push(
      makeError(
        directoryName,
        "warning",
        "conflicting_site_mode",
        "The site directory contains both Full and Discovery primary artifacts.",
        directory,
      ),
    );
  }

  const primarySections = outreachPath ? outreachSections : productionSections;
  const currentResultSection = primarySections.get("RESULT") ?? "";
  const currentRunSection = primarySections.get("RUN") ?? "";
  const currentDiscoverySection = primarySections.get("DISCOVERY") ?? "";
  const currentSubmissionSection = primarySections.get("SUBMISSION") ?? "";
  const currentNetworkSection = primarySections.get("NETWORK") ?? "";
  const currentArtifactsSection = primarySections.get("ARTIFACTS") ?? "";
  const currentBrowserSection = primarySections.get("BROWSER STAGE") ?? "";
  const legacyTextReport = productionText || discoveryText;
  const formReport = outreachPath
    ? outreachFormText
    : productionSections.size > 0
      ? formTextFromOutreachSections(productionSections)
      : legacyTextReport;
  const currentStatus = parseField(currentResultSection, "Status");
  const legacyStatus = parseField(productionText, "Status");
  const productionStructuredStatus = parseField(productionSections.get("RESULT") ?? "", "Status");
  const currentUrl = parseField(currentRunSection, "Website");
  const legacyUrl = parseField(legacyTextReport, "Website");
  let conflictingStructuredEvidence = false;
  if (outreachPath && productionPath) {
    const statusConflict = currentStatus && (productionStructuredStatus || legacyStatus) &&
      currentStatus !== (productionStructuredStatus || legacyStatus);
    const productionUrl = parseField(productionSections.get("RUN") ?? "", "Website") || legacyUrl;
    const urlConflict = currentUrl && productionUrl && currentUrl !== productionUrl;
    if (statusConflict || urlConflict) {
      conflictingStructuredEvidence = true;
      errors.push(
        makeError(
          directoryName,
          "warning",
          "conflicting_overlapping_primary_artifacts",
          `${path.basename(outreachPath)} and production.txt contain contradictory form fields; ${path.basename(outreachPath)} was used.`,
          directory,
        ),
      );
    }
  }

  const jsonAssessment = discoveryResult ? stringValue(discoveryResult.assessment) : "";
  const textAssessment = parseField(currentDiscoverySection || legacyTextReport, "Assessment");
  const jsonUrl = discoveryResult ? stringValue(discoveryResult.websiteUrl) : "";
  const websiteUrl = currentUrl || jsonUrl || legacyUrl || findWebsiteUrl(inputJson);
  let browserStage = parseBrowserStageSection(currentBrowserSection);
  const reportedBrowserArtifact = browserStage?.artifactPath;
  if (reportedBrowserArtifact && reportedBrowserArtifact !== "none") {
    const reportedDebugDirectory = path.dirname(path.dirname(reportedBrowserArtifact));
    const resolvedDebug = await resolveDebugDirectory(directory, reportedDebugDirectory);
    if (resolvedDebug.directory) {
      const browserArtifactPath = path.join(resolvedDebug.directory, "browser", "browser-stage.json");
      if (await existingFile(browserArtifactPath)) {
        try {
          browserStage = browserStageFromJson(parseJsonText(await readTextSafe(browserArtifactPath))) ?? browserStage;
          sourcePaths.push(browserArtifactPath);
        } catch (error) {
          errors.push(makeError(directoryName, "warning", "malformed_browser_stage_artifact", String(error), browserArtifactPath));
        }
      }
    }
  }
  const status = currentStatus || legacyStatus;
  const reason =
    (parseField(currentResultSection, "Reason") || parseField(productionText, "Reason")) ||
    (discoveryResult ? stringValue(discoveryResult.description) : "") ||
    parseField(discoveryText, "Description");
  const failureKind = inputMalformed
    ? "input.invalid"
    : parseField(currentResultSection, "Failure kind") || parseField(productionText, "Failure kind");
  const discoveryAssessment = jsonAssessment || textAssessment;
  const discoveryReport = currentDiscoverySection || legacyTextReport;
  const presenceEvidenceStrength =
    (discoveryResult ? stringValue(discoveryResult.presenceEvidenceStrength) : "") ||
    parseField(discoveryReport, "Presence evidence strength");
  const searchCoverage =
    (discoveryResult ? stringValue(discoveryResult.searchCoverage) : "") ||
    parseField(discoveryReport, "Search coverage");
  const description =
    (discoveryResult ? stringValue(discoveryResult.description) : "") ||
    parseField(discoveryReport, "Discovery description") ||
    parseField(discoveryReport, "Description");
  const jsonContactFormFound = discoveryResult ? booleanValue(discoveryResult.contactFormFound) : undefined;
  const textContactFormFound = parseYesNo(
    parseField(discoveryReport, outreachPath || productionText ? "Form found" : "Contact form found"),
  );
  const contactFormFound = jsonContactFormFound ?? textContactFormFound;
  const submissionReport = currentSubmissionSection || productionText;
  const submissionAttempted = parseYesNo(parseField(submissionReport, "Attempted"));
  const submissionConfirmed = parseYesNo(parseField(submissionReport, "Confirmed"));
  const unknownSubmissionSignals = parseRepeatedField(submissionReport, "Unknown signal")
    .map((line) => {
      const [kind = "unknown", fingerprint = "", summary = "", reason = ""] =
        line.split("|").map((part) => part.trim());
      return { kind, fingerprint, summary, reason };
    })
    .filter((candidate) => candidate.fingerprint.length > 0);
  const rejection = parseRejectionEvidence(parseField(currentSubmissionSection, "Rejection evidence"));
  const network = parseNetworkEvidence(parseField(currentNetworkSection, "Network submission evidence"));
  const networkRejectsSubmission = parseYesNo(
    parseField(currentNetworkSection, "Network rejection evidence"),
  );
  const networkBestRequest = parseNetworkRequest(
    parseField(currentNetworkSection, "Best submission request"),
  );
  const reportedDebugPath = parseField(currentArtifactsSection, "Debug artifacts");
  const submissionSignals: FormSubmissionSignalEvidence = primarySections.has("SUBMISSION")
    ? {
        ...emptySubmissionSignalEvidence(),
        primaryAvailable: true,
        confirmationEvidence: normalizeConfirmationEvidence(
          parseField(currentSubmissionSection, "Confirmation evidence"),
        ),
        postClickDisposition: parseField(currentSubmissionSection, "Post-click disposition"),
        rejectionEvidenceCount: rejection.count,
        rejectionCategories: rejection.categories,
        networkAvailable: primarySections.has("NETWORK"),
        ...(network.found !== undefined ? { networkEvidenceFound: network.found } : {}),
        networkConfidence: network.confidence,
        ...(networkRejectsSubmission !== undefined ? { networkRejectsSubmission } : {}),
        networkProviderRuleId: parseField(currentNetworkSection, "Network provider rule"),
        ...(networkBestRequest ? { networkBestRequest } : {}),
        networkReason: parseField(currentNetworkSection, "Network evidence reason"),
        debugPathReported: Boolean(reportedDebugPath),
        arithmetic: parseArithmeticEvidence(currentSubmissionSection),
      }
    : emptySubmissionSignalEvidence();
  if (submissionSignals.arithmetic.presence === "malformed") {
    errors.push(
      makeError(
        directoryName,
        "warning",
        "malformed_arithmetic_signal_output",
        submissionSignals.arithmetic.parseErrors.join(" "),
        primaryTextPath ?? directory,
      ),
    );
  }

  if (primaryTextPath && reportedDebugPath) {
    const resolvedDebug = await resolveDebugDirectory(directory, reportedDebugPath);
    submissionSignals.unsafeDebugPath = resolvedDebug.unsafe;
    if (resolvedDebug.unsafe) {
      errors.push(
        makeError(
          directoryName,
          "warning",
          "unsafe_signal_debug_path",
          "The reported debug-artifact path was outside the current site directory and was not read directly.",
          primaryTextPath,
        ),
      );
    }
    if (resolvedDebug.directory) {
      const submissionDebugPath = path.join(resolvedDebug.directory, "submission-debug.json");
      const confirmationEventsPath = path.join(resolvedDebug.directory, "confirmation", "events.jsonl");
      submissionSignals.debugArtifactAvailable = await existingFile(submissionDebugPath);
      submissionSignals.confirmationEventsAvailable = await existingFile(confirmationEventsPath);
      if (submissionSignals.debugArtifactAvailable) {
        const submissionDebugText = await readTextSafe(submissionDebugPath);
        try {
          const submissionDebug = parseJsonText(submissionDebugText);
          const networkSubmissionEvidence =
            isObject(submissionDebug) && isObject(submissionDebug.networkSubmissionEvidence)
              ? submissionDebug.networkSubmissionEvidence
              : null;
          const bestRejectionRequest = networkSubmissionEvidence
            ? parseNetworkRequestObject(networkSubmissionEvidence.bestRejectionRequest)
            : undefined;
          if (bestRejectionRequest) {
            submissionSignals.networkBestRejectionRequest = bestRejectionRequest;
          }
        } catch {
          submissionSignals.debugArtifactMalformed = true;
          errors.push(
            makeError(
              directoryName,
              "warning",
              "malformed_signal_debug_artifact",
              "submission-debug.json could not be parsed; primary signal evidence was retained.",
              submissionDebugPath,
            ),
          );
        }
        sourcePaths.push(submissionDebugPath);
      }
      if (submissionSignals.confirmationEventsAvailable) {
        const eventText = await readTextSafe(confirmationEventsPath);
        const parsedMessages = parseDebugMessageSignals(eventText);
        submissionSignals.messageSignals = parsedMessages.signals;
        submissionSignals.debugArtifactMalformed =
          submissionSignals.debugArtifactMalformed || parsedMessages.malformed;
        sourcePaths.push(confirmationEventsPath);
        if (parsedMessages.malformed) {
          errors.push(
            makeError(
              directoryName,
              "warning",
              "malformed_signal_debug_artifact",
              "At least one confirmation event could not be parsed; valid events were retained.",
              confirmationEventsPath,
            ),
          );
        }
      }
    }
  }

  if (jsonAssessment && textAssessment && jsonAssessment !== textAssessment) conflictingStructuredEvidence = true;
  if (
    jsonContactFormFound !== undefined &&
    textContactFormFound !== undefined &&
    jsonContactFormFound !== textContactFormFound
  ) {
    conflictingStructuredEvidence = true;
  }
  if (
    conflictingStructuredEvidence &&
    !errors.some((error) => error.code === "conflicting_overlapping_primary_artifacts")
  ) {
    errors.push(
      makeError(
        directoryName,
        "warning",
        "conflicting_structured_evidence",
        "Structured JSON and structured text disagree about the form discovery result.",
        directory,
      ),
    );
  }

  const debugEvidence: string[] = [];
  for (const debugName of DEBUG_FILES) {
    const debugPath = findNamedPath(directory, names, debugName);
    if (!debugPath) continue;
    const debugText = await readTextSafe(debugPath);
    if (debugText) debugEvidence.push(`${debugName}: ${debugText.slice(0, 50_000)}`);
    sourcePaths.push(debugPath);
  }

  if (!websiteUrl) {
    errors.push(makeError(directoryName, "warning", "missing_website_url", "No website URL was found in site artifacts.", directory));
  }

  const hasPrimary = Boolean(outreachPath || productionPath || discoveryJsonPath || discoveryTextPath);
  if (!hasPrimary && !inputMalformed) {
    errors.push(
      makeError(
        directoryName,
        "warning",
        "missing_primary_result",
        "No current or legacy primary result artifact was found; all channels remain incomplete.",
        directory,
      ),
    );
  }

  return {
    id: directoryName,
    numericId,
    directory,
    websiteUrl,
    mode,
    sourcePaths,
    ...(inputPath ? { inputPath } : {}),
    ...(discoveryJsonPath ? { primaryJsonPath: discoveryJsonPath } : {}),
    ...(primaryTextPath ? { primaryTextPath } : {}),
    hasOnlyInput: !hasPrimary && !inputMalformed,
    primaryArtifactMalformed,
    conflictingModeEvidence,
    conflictingStructuredEvidence,
    status,
    reason: inputMalformed ? "Input JSON is malformed and no reliable input could be read." : reason,
    failureKind,
    discoveryAssessment,
    presenceEvidenceStrength,
    searchCoverage,
    description,
    ...(contactFormFound !== undefined ? { contactFormFound } : {}),
    ...(submissionAttempted !== undefined ? { submissionAttempted } : {}),
    ...(submissionConfirmed !== undefined ? { submissionConfirmed } : {}),
    submissionSignals,
    unknownSubmissionSignals,
    fullText: formReport,
    structuredEvidence: compactJsonEvidence(discoveryResult),
    debugEvidence,
    ...(browserStage ? { browserStage } : {}),
    emails: parseDiscoveryEvidence("emails", outreachSections.get("EMAIL DISCOVERY")),
    meetings: parseDiscoveryEvidence("meetings", outreachSections.get("MEETING DISCOVERY")),
    errors,
  };
};

const readSummaryMetadata = async (
  runPath: string,
): Promise<{
  plannedCount: number | null;
  declaredCompletedCount: number | null;
  declaredMode: string;
  warnings: string[];
}> => {
  const summaryPath = path.join(runPath, "summary.json");
  let raw = "";
  try {
    raw = await readFile(summaryPath, "utf8");
  } catch {
    // A summary is optional; per-site primary artifacts remain authoritative.
  }
  if (!raw) return { plannedCount: null, declaredCompletedCount: null, declaredMode: "", warnings: [] };
  try {
    const summary = parseJsonText(raw);
    if (!isObject(summary)) throw new Error("summary.json does not contain an object.");
    return {
      plannedCount:
        numberValue(summary.selectedThisInvocation) ??
        numberValue(summary.selectedCount) ??
        numberValue(summary.plannedCount) ??
        numberValue(summary.totalSites),
      declaredCompletedCount:
        numberValue(summary.completedThisInvocation) ?? numberValue(summary.completedCount),
      declaredMode: (stringValue(summary.workflowMode) || stringValue(summary.mode)).toLowerCase(),
      warnings: [],
    };
  } catch (error) {
    return {
      plannedCount: null,
      declaredCompletedCount: null,
      declaredMode: "",
      warnings: [`summary.json could not be parsed and was used for neither evidence nor counts: ${String(error)}`],
    };
  }
};

const normalizeDeclaredMode = (value: string): WorkflowMode | "" => {
  if (value === "discovery") return "discovery";
  if (["production", "deep-debug", "full"].includes(value)) return "full";
  if (value === "mixed") return "mixed";
  return "";
};

export const readRunArtifacts = async (requestedPath: string): Promise<RunArtifacts> => {
  const runPath = path.resolve(requestedPath);
  let info;
  try {
    info = await stat(runPath);
  } catch {
    throw new Error(`Run path does not exist: ${runPath}`);
  }
  if (!info.isDirectory()) throw new Error(`Run path is not a directory: ${runPath}`);

  const entries = await readdir(runPath, { withFileTypes: true });
  const numericDirectories = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .sort((left, right) => Number.parseInt(left.name, 10) - Number.parseInt(right.name, 10));
  if (numericDirectories.length === 0) {
    throw new Error(`No numeric site directories or recognizable run artifacts were found in: ${runPath}`);
  }

  const sites: SiteEvidence[] = [];
  const readConcurrency = 32;
  for (let index = 0; index < numericDirectories.length; index += readConcurrency) {
    const batch = numericDirectories.slice(index, index + readConcurrency);
    sites.push(...(await Promise.all(batch.map((entry) => readSite(runPath, entry.name)))));
  }
  if (!sites.some((site) => site.inputPath || site.primaryJsonPath || site.primaryTextPath)) {
    throw new Error(`No recognizable input or result artifacts were found in numeric directories under: ${runPath}`);
  }

  const metadata = await readSummaryMetadata(runPath);
  const fullCount = sites.filter((site) => site.mode === "full").length;
  const discoveryCount = sites.filter((site) => site.mode === "discovery").length;
  const conflictingCount = sites.filter((site) => site.mode === "conflicting").length;
  const inferredMode: WorkflowMode =
    conflictingCount > 0 || (fullCount > 0 && discoveryCount > 0)
      ? "mixed"
      : discoveryCount > 0
        ? "discovery"
        : "full";
  const warnings = [...metadata.warnings];
  const declaredMode = normalizeDeclaredMode(metadata.declaredMode);
  if (declaredMode && declaredMode !== inferredMode) {
    warnings.push(
      `summary.json declares mode '${metadata.declaredMode}', while primary site artifacts indicate '${inferredMode}'. Primary artifacts were used.`,
    );
  }
  if (inferredMode === "mixed") warnings.push("Mixed or conflicting Full/Discovery primary artifacts were detected.");
  if (metadata.plannedCount !== null && metadata.plannedCount < sites.length) {
    warnings.push(
      `The planned count (${metadata.plannedCount}) is lower than the number of numeric site directories (${sites.length}); not-started is reported as zero.`,
    );
  }
  const primaryResultCount = sites.filter((site) => site.primaryJsonPath || site.primaryTextPath).length;
  if (metadata.declaredCompletedCount !== null && metadata.declaredCompletedCount !== primaryResultCount) {
    warnings.push(
      `summary.json completed count (${metadata.declaredCompletedCount}) does not match current per-site primary artifacts (${primaryResultCount}); per-site artifacts were used.`,
    );
  }

  return {
    runPath,
    mode: inferredMode,
    plannedCount: metadata.plannedCount,
    sites,
    errors: sites.flatMap((site) => site.errors),
    warnings,
  };
};
