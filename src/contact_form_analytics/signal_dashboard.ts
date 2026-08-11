import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "playwright";
import type {
  FormAnalyticsResult,
  FormSignalStatistic,
  FormSignalStatistics,
} from "./analytics_types.js";

interface DashboardSignalDefinition {
  key: string;
  label: string;
  shortLabel: string;
  signalType: string;
}

interface DashboardIntersection {
  key: string;
  label: string;
  signalKeys: string[];
  count: number;
  siteIds: string[];
}

interface DashboardHttpCode {
  code: string;
  count: number;
  description: string;
  siteIds: string[];
}

interface DashboardHttpClass {
  key: string;
  label: string;
  count: number;
  siteIds: string[];
  codes: DashboardHttpCode[];
}

interface DashboardHttpPolarity {
  key: "positive" | "negative";
  label: string;
  count: number;
  siteIds: string[];
  classes: DashboardHttpClass[];
}

interface DashboardCorrelation {
  key: string;
  label: string;
  count: number;
  description: string;
  siteIds: string[];
}

interface DashboardSite {
  id: string;
  websiteUrl: string;
  status: string;
  positive: boolean;
  negative: boolean;
  confirmationSignals: string[];
  positiveHttpCodes: string[];
  negativeHttpCodes: string[];
  correlationMethods: string[];
  providerRules: string[];
  successMessages: string[];
  rejectionMessages: string[];
}

interface SignalDashboardData {
  generatedAt: string;
  rulebookVersion: string;
  denominators: {
    processed: number;
    submissionAttempts: number;
    positive: number;
    negative: number;
    overlap: number;
  };
  signalDefinitions: DashboardSignalDefinition[];
  intersections: DashboardIntersection[];
  http: DashboardHttpPolarity[];
  correlations: DashboardCorrelation[];
  providers: DashboardCorrelation[];
  successMessages: DashboardCorrelation[];
  sites: DashboardSite[];
}

const SIGNAL_DEFINITIONS: DashboardSignalDefinition[] = [
  {
    key: "network",
    label: "HTTP network confirmation",
    shortLabel: "HTTP",
    signalType: "network_confirmation",
  },
  {
    key: "visible_text",
    label: "Visible success text",
    shortLabel: "Text",
    signalType: "visible_success_text",
  },
  {
    key: "success_url",
    label: "Success URL",
    shortLabel: "URL",
    signalType: "success_url",
  },
  {
    key: "ai_text",
    label: "AI-verified visible text",
    shortLabel: "AI",
    signalType: "ai_verified_visible_text",
  },
];

const HTTP_CODE_MEANINGS: Record<string, string> = {
  "200": "OK — the correlated form-like request completed successfully.",
  "201": "Created — the server created a resource from the submission.",
  "202": "Accepted — the server accepted the request for asynchronous processing.",
  "204": "No Content — the request succeeded without returning page content.",
  "301": "Moved Permanently — the server redirected after receiving the request.",
  "302": "Found — the server issued a temporary redirect after the request.",
  "303": "See Other — the server redirected to another page after the POST.",
  "307": "Temporary Redirect — the request was redirected without changing its method.",
  "308": "Permanent Redirect — the request was permanently redirected without changing its method.",
  "400": "Bad Request — the server rejected the submitted request as invalid.",
  "401": "Unauthorized — the endpoint required authorization that was not available.",
  "403": "Forbidden — the server refused the request.",
  "404": "Not Found — the submission endpoint was not found.",
  "405": "Method Not Allowed — the endpoint rejected the HTTP method used.",
  "406": "Not Acceptable — the endpoint could not return an acceptable response.",
  "409": "Conflict — the request conflicted with the server's current state.",
  "422": "Unprocessable Content — the server understood but rejected the submitted values.",
  "429": "Too Many Requests — the endpoint rate-limited the request.",
  "500": "Internal Server Error — the server failed while handling the request.",
  "502": "Bad Gateway — an upstream service returned an invalid response.",
  "503": "Service Unavailable — the service was temporarily unavailable.",
  "504": "Gateway Timeout — an upstream service did not answer in time.",
  request_failed: "Transport failure — the request did not receive an HTTP response.",
};

const labelToken = (value: string): string =>
  value
    .split("_")
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");

const findRow = (
  statistics: FormSignalStatistics,
  polarity: "positive" | "negative",
  signalFamily: string,
  signalType: string,
  signalValue?: string,
): FormSignalStatistic | undefined =>
  statistics[polarity].find(
    (row) =>
      row.signalFamily === signalFamily &&
      row.signalType === signalType &&
      (signalValue === undefined || row.signalValue === signalValue),
  );

const matchingRows = (
  statistics: FormSignalStatistics,
  polarity: "positive" | "negative",
  signalFamily: string,
  signalType?: string,
): FormSignalStatistic[] =>
  statistics[polarity].filter(
    (row) =>
      row.signalFamily === signalFamily &&
      (signalType === undefined || row.signalType === signalType),
  );

const valuesForSite = (rows: FormSignalStatistic[], siteId: string): string[] =>
  rows
    .filter((row) => row.siteIds.includes(siteId))
    .map((row) => row.signalValue);

const compareHttpCodes = (left: DashboardHttpCode, right: DashboardHttpCode): number => {
  if (left.code === "request_failed") return 1;
  if (right.code === "request_failed") return -1;
  return Number(left.code) - Number(right.code);
};

const makeHttpPolarity = (
  statistics: FormSignalStatistics,
  polarity: "positive" | "negative",
): DashboardHttpPolarity => {
  const total =
    polarity === "positive"
      ? findRow(statistics, "positive", "confirmation", "network_confirmation")
      : findRow(statistics, "negative", "rejection_source", "network_rejection");
  const statusRows = matchingRows(statistics, polarity, "network_http_status", "http_status");
  const transportRows = matchingRows(
    statistics,
    polarity,
    "network_transport",
    "transport_failure",
  );
  const classRows = matchingRows(
    statistics,
    polarity,
    "network_response_class",
    "http_response_class",
  );
  const classes = classRows
    .filter((row) => row.count > 0)
    .map((row) => ({
      key: `${polarity}:${row.signalValue}`,
      label: row.signalValue.toUpperCase(),
      count: row.count,
      siteIds: row.siteIds,
      codes: statusRows
        .filter((status) => status.signalValue.startsWith(row.signalValue.slice(0, 1)))
        .map((status) => ({
          code: status.signalValue,
          count: status.count,
          description: HTTP_CODE_MEANINGS[status.signalValue] ?? status.description,
          siteIds: status.siteIds,
        }))
        .sort(compareHttpCodes),
    }));
  for (const row of transportRows.filter((candidate) => candidate.count > 0)) {
    classes.push({
      key: `${polarity}:transport`,
      label: "Transport",
      count: row.count,
      siteIds: row.siteIds,
      codes: [
        {
          code: row.signalValue,
          count: row.count,
          description: HTTP_CODE_MEANINGS[row.signalValue] ?? row.description,
          siteIds: row.siteIds,
        },
      ],
    });
  }
  return {
    key: polarity,
    label: polarity === "positive" ? "Positive confirmation" : "Network rejection",
    count: total?.count ?? 0,
    siteIds: total?.siteIds ?? [],
    classes,
  };
};

const dashboardRows = (
  statistics: FormSignalStatistics,
  polarity: "positive" | "negative",
  family: string,
): DashboardCorrelation[] =>
  matchingRows(statistics, polarity, family)
    .filter((row) => row.count > 0)
    .map((row) => ({
      key: `${polarity}:${family}:${row.signalValue}`,
      label: labelToken(row.signalValue),
      count: row.count,
      description: row.description,
      siteIds: row.siteIds,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));

const buildIntersections = (statistics: FormSignalStatistics): DashboardIntersection[] => {
  const signalSites = new Map(
    SIGNAL_DEFINITIONS.map((definition) => [
      definition.key,
      new Set(
        findRow(
          statistics,
          "positive",
          "confirmation",
          definition.signalType,
        )?.siteIds ?? [],
      ),
    ]),
  );
  const grouped = new Map<string, string[]>();
  for (const siteId of statistics.sitesWithAnyPositiveSignal.siteIds) {
    const keys = SIGNAL_DEFINITIONS.filter((definition) =>
      signalSites.get(definition.key)?.has(siteId),
    ).map((definition) => definition.key);
    if (keys.length === 0) continue;
    const key = keys.join("+");
    const ids = grouped.get(key) ?? [];
    ids.push(siteId);
    grouped.set(key, ids);
  }
  return [...grouped.entries()]
    .map(([key, siteIds]) => {
      const signalKeys = key.split("+");
      return {
        key,
        label: SIGNAL_DEFINITIONS.filter((definition) =>
          signalKeys.includes(definition.key),
        )
          .map((definition) => definition.label)
          .join(" + "),
        signalKeys,
        count: siteIds.length,
        siteIds,
      };
    })
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.signalKeys.length - right.signalKeys.length ||
        left.label.localeCompare(right.label),
    );
};

export const buildSignalDashboardData = (
  result: FormAnalyticsResult,
): SignalDashboardData => {
  const statistics = result.signalStatistics;
  const positiveConfirmationRows = matchingRows(
    statistics,
    "positive",
    "confirmation",
  );
  const positiveHttpRows = matchingRows(
    statistics,
    "positive",
    "network_http_status",
    "http_status",
  );
  const negativeHttpRows = matchingRows(
    statistics,
    "negative",
    "network_http_status",
    "http_status",
  );
  const positiveTransportRows = matchingRows(
    statistics,
    "positive",
    "network_transport",
    "transport_failure",
  );
  const negativeTransportRows = matchingRows(
    statistics,
    "negative",
    "network_transport",
    "transport_failure",
  );
  const correlationRows = matchingRows(
    statistics,
    "positive",
    "network_correlation",
    "correlation_basis",
  );
  const providerRows = [
    ...matchingRows(statistics, "positive", "network_provider", "provider_rule"),
    ...matchingRows(statistics, "negative", "network_provider", "provider_rule"),
  ];
  const successMessageRows = matchingRows(
    statistics,
    "positive",
    "message_variant",
  );
  const rejectionMessageRows = matchingRows(
    statistics,
    "negative",
    "message_variant",
  );
  const positiveIds = new Set(statistics.sitesWithAnyPositiveSignal.siteIds);
  const negativeIds = new Set(statistics.sitesWithAnyNegativeSignal.siteIds);
  const sites = result.sites.map((site) => ({
    id: site.id,
    websiteUrl: site.websiteUrl,
    status: site.status,
    positive: positiveIds.has(site.id),
    negative: negativeIds.has(site.id),
    confirmationSignals: valuesForSite(positiveConfirmationRows, site.id),
    positiveHttpCodes: [
      ...valuesForSite(positiveHttpRows, site.id),
      ...valuesForSite(positiveTransportRows, site.id),
    ],
    negativeHttpCodes: [
      ...valuesForSite(negativeHttpRows, site.id),
      ...valuesForSite(negativeTransportRows, site.id),
    ],
    correlationMethods: valuesForSite(correlationRows, site.id),
    providerRules: valuesForSite(providerRows, site.id),
    successMessages: valuesForSite(successMessageRows, site.id),
    rejectionMessages: valuesForSite(rejectionMessageRows, site.id),
  }));
  return {
    generatedAt: result.generatedAt,
    rulebookVersion: statistics.rulebookVersion,
    denominators: {
      processed: statistics.processedSites.count,
      submissionAttempts: statistics.submissionAttemptedSites.count,
      positive: statistics.sitesWithAnyPositiveSignal.count,
      negative: statistics.sitesWithAnyNegativeSignal.count,
      overlap: statistics.sitesWithBothPolarities.count,
    },
    signalDefinitions: SIGNAL_DEFINITIONS,
    intersections: buildIntersections(statistics),
    http: [
      makeHttpPolarity(statistics, "positive"),
      makeHttpPolarity(statistics, "negative"),
    ],
    correlations: dashboardRows(statistics, "positive", "network_correlation"),
    providers: [
      ...dashboardRows(statistics, "positive", "network_provider").map((row) => ({
        ...row,
        label: `${row.label} · confirmation`,
      })),
      ...dashboardRows(statistics, "negative", "network_provider").map((row) => ({
        ...row,
        label: `${row.label} · rejection`,
      })),
    ],
    successMessages: dashboardRows(statistics, "positive", "message_variant"),
    sites,
  };
};

const safeJson = (value: unknown): string =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");

export const renderSignalDashboardHtml = (result: FormAnalyticsResult): string => {
  const payload = safeJson(buildSignalDashboardData(result));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Form submission signal dashboard</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f7f8fb;
      --surface: #ffffff;
      --text: #172033;
      --muted: #5e6a7d;
      --border: #d9dfeb;
      --grid: #e8ecf3;
      --positive: #17875b;
      --positive-soft: #dff5eb;
      --negative: #c34343;
      --negative-soft: #fde7e7;
      --redirect: #4c6fdc;
      --redirect-soft: #e4eaff;
      --accent: #7a5bc7;
      --accent-soft: #eee8fb;
      --neutral: #6d7788;
      --selected: #fff5cb;
      --shadow: 0 12px 35px rgba(31, 42, 68, 0.08);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #11151d;
        --surface: #1a202b;
        --text: #edf1f7;
        --muted: #aab4c5;
        --border: #354052;
        --grid: #2a3342;
        --positive: #55c99a;
        --positive-soft: #153e31;
        --negative: #f07777;
        --negative-soft: #492424;
        --redirect: #87a0ff;
        --redirect-soft: #26345f;
        --accent: #b69af4;
        --accent-soft: #352a50;
        --neutral: #a2adbd;
        --selected: #4d421d;
        --shadow: none;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, "Segoe UI", Arial, sans-serif;
      line-height: 1.45;
    }
    button, input { font: inherit; }
    button { color: inherit; }
    .dashboard {
      width: min(1440px, 100%);
      margin: 0 auto;
      padding: 28px;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: flex-start;
      margin-bottom: 20px;
    }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 6px; font-size: clamp(24px, 3vw, 38px); font-weight: 650; }
    h2 { margin-bottom: 6px; font-size: 21px; font-weight: 650; }
    h3 { margin-bottom: 8px; font-size: 16px; font-weight: 650; }
    .muted { color: var(--muted); }
    .small { font-size: 13px; }
    .summary {
      display: grid;
      grid-template-columns: repeat(5, minmax(130px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: var(--shadow);
    }
    .metric { padding: 15px 17px; }
    .metric .value { font-size: 28px; font-weight: 650; margin-top: 2px; }
    .metric .label { color: var(--muted); font-size: 13px; }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(340px, .7fr);
      gap: 18px;
      margin-bottom: 18px;
    }
    .panel { padding: 20px; min-width: 0; }
    .panel-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    .http-layout {
      display: grid;
      grid-template-columns: minmax(330px, .9fr) minmax(300px, 1.1fr);
      gap: 16px;
      align-items: center;
    }
    #http-chart { width: 100%; min-height: 410px; }
    .http-list { display: grid; gap: 7px; }
    .http-row, .bar-row, .message-row {
      width: 100%;
      border: 0;
      background: transparent;
      text-align: left;
      border-radius: 8px;
      padding: 7px 9px;
      cursor: pointer;
    }
    .http-row:hover, .http-row:focus-visible,
    .bar-row:hover, .bar-row:focus-visible,
    .message-row:hover, .message-row:focus-visible {
      background: var(--accent-soft);
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .http-row .topline, .bar-label {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
    }
    .meaning { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .positive-text { color: var(--positive); }
    .negative-text { color: var(--negative); }
    .bars { display: grid; gap: 12px; margin-top: 15px; }
    .bar-track {
      display: block;
      height: 12px;
      background: var(--grid);
      border-radius: 99px;
      overflow: hidden;
      margin-top: 5px;
    }
    .bar-fill { display: block; height: 100%; background: var(--redirect); border-radius: inherit; }
    .bar-row .meaning { display: block; }
    .providers {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    .provider-grid { display: grid; gap: 6px; }
    .provider-line {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 0;
      border-bottom: 1px solid var(--grid);
    }
    .upset-wrap { overflow-x: auto; padding-bottom: 4px; }
    #upset-chart { min-width: 680px; width: 100%; min-height: 385px; }
    .message-list { display: grid; gap: 7px; margin-top: 12px; }
    .message-row {
      display: grid;
      grid-template-columns: 50px 1fr;
      gap: 12px;
      border-bottom: 1px solid var(--grid);
      border-radius: 0;
    }
    .message-count { font-weight: 650; text-align: right; }
    .details {
      margin-top: 18px;
      grid-template-columns: minmax(0, .75fr) minmax(0, 1.25fr);
    }
    .details-controls { display: flex; gap: 10px; align-items: center; }
    .btn {
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: 8px;
      padding: 7px 11px;
      cursor: pointer;
    }
    .btn:hover, .btn:focus-visible { border-color: var(--accent); outline: 2px solid var(--accent); }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; vertical-align: top; padding: 9px 10px; border-bottom: 1px solid var(--grid); }
    th { color: var(--muted); font-weight: 600; white-space: nowrap; }
    td:first-child, th:first-child { padding-left: 0; }
    td:last-child, th:last-child { padding-right: 0; }
    .status {
      display: inline-block;
      border-radius: 99px;
      padding: 2px 7px;
      background: var(--grid);
      font-size: 12px;
    }
    .tooltip {
      position: fixed;
      display: none;
      max-width: 290px;
      z-index: 10;
      background: var(--text);
      color: var(--surface);
      border-radius: 7px;
      padding: 8px 10px;
      font-size: 12px;
      pointer-events: none;
      box-shadow: var(--shadow);
    }
    .tooltip.visible { display: block; }
    svg text { font-family: inherit; fill: var(--text); }
    .arc { cursor: pointer; stroke: var(--surface); stroke-width: 2; }
    .arc:hover, .arc:focus { filter: brightness(1.08); outline: none; }
    .upset-column { cursor: pointer; }
    .upset-column:hover .upset-bar, .upset-column:focus .upset-bar { filter: brightness(1.12); }
    .upset-column:focus { outline: none; }
    .selected-mark { fill: var(--selected); opacity: .65; }
    @media (max-width: 980px) {
      .summary { grid-template-columns: repeat(3, 1fr); }
      .layout { grid-template-columns: 1fr; }
      .details { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .dashboard { padding: 16px; }
      header { display: block; }
      .summary { grid-template-columns: repeat(2, 1fr); }
      .http-layout { grid-template-columns: 1fr; }
      .panel { padding: 15px; }
    }
  </style>
</head>
<body>
  <main id="signal-dashboard" class="dashboard">
    <header>
      <div>
        <h1>Form submission signal dashboard</h1>
        <p class="muted">Multi-label evidence across all attempted submissions. HTTP success is counted only for correlated form-like requests observed after submission.</p>
      </div>
      <div class="muted small" id="generated-at"></div>
    </header>

    <section class="summary" aria-label="Signal summary">
      <div class="card metric"><div class="label">Submission attempts</div><div class="value" id="attempt-count"></div></div>
      <div class="card metric"><div class="label">Any positive evidence</div><div class="value positive-text" id="positive-count"></div></div>
      <div class="card metric"><div class="label">Any strict negative evidence</div><div class="value negative-text" id="negative-count"></div></div>
      <div class="card metric"><div class="label">Both polarities</div><div class="value" id="overlap-count"></div></div>
      <div class="card metric"><div class="label">Processed sites</div><div class="value" id="processed-count"></div></div>
    </section>

    <section class="layout">
      <article class="card panel">
        <div class="panel-head">
          <div>
            <h2>HTTP evidence arc</h2>
            <p class="muted small">Inner ring: positive confirmation versus rejection. Middle ring: response class. Outer ring: exact HTTP code. Positive and rejection populations may overlap.</p>
          </div>
        </div>
        <div class="http-layout">
          <div id="http-chart" role="img" aria-label="Sunburst chart of network evidence by polarity, HTTP response class, and exact code"></div>
          <div>
            <h3>Exact responses</h3>
            <div id="http-list" class="http-list"></div>
          </div>
        </div>
      </article>

      <article class="card panel">
        <h2>Why the request is connected to the form</h2>
        <p class="muted small">These are alternative correlation explanations for the same network-confirmed sites; they should not be added to the HTTP totals.</p>
        <div id="correlation-bars" class="bars"></div>
        <div class="providers">
          <h3>Provider rules</h3>
          <div id="provider-list" class="provider-grid"></div>
        </div>
      </article>
    </section>

    <section class="card panel">
      <div class="panel-head">
        <div>
          <h2>Exact positive-signal combinations</h2>
          <p class="muted small">Each column is an exact combination. A filled dot means that signal was present; connected dots occurred on the same websites.</p>
        </div>
      </div>
      <div class="upset-wrap">
        <div id="upset-chart" role="img" aria-label="UpSet plot of exact positive submission-signal combinations"></div>
      </div>
    </section>

    <section class="layout details">
      <article class="card panel">
        <h2>Visible success-message variants</h2>
        <p class="muted small">Whitespace and case are normalized for grouping. These are contained, redacted confirmation messages—not arbitrary message candidates.</p>
        <div id="message-list" class="message-list"></div>
      </article>

      <article class="card panel">
        <div class="panel-head">
          <div>
            <h2 id="selection-title">Selected evidence</h2>
            <p class="muted small" id="selection-summary"></p>
          </div>
          <div class="details-controls">
            <button type="button" class="btn" id="show-all">Show all</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Site</th><th>Status</th><th>Website</th><th>Evidence</th></tr>
            </thead>
            <tbody id="site-table"></tbody>
          </table>
        </div>
      </article>
    </section>
  </main>
  <div id="tooltip" class="tooltip" role="status"></div>
  <script>
    (function () {
      "use strict";
      const data = ${payload};
      const root = document.getElementById("signal-dashboard");
      const ns = "http://www.w3.org/2000/svg";
      const siteById = new Map(data.sites.map(function (site) { return [site.id, site]; }));
      let selectedIds = [];
      let showAll = false;

      function setText(id, value) {
        document.getElementById(id).textContent = String(value);
      }

      function svgElement(name, attributes, text) {
        const node = document.createElementNS(ns, name);
        Object.keys(attributes || {}).forEach(function (key) {
          node.setAttribute(key, String(attributes[key]));
        });
        if (text !== undefined) node.textContent = text;
        return node;
      }

      function evidenceText(site) {
        const chunks = [];
        if (site.positiveHttpCodes.length) chunks.push("Positive HTTP: " + site.positiveHttpCodes.join(", "));
        if (site.negativeHttpCodes.length) chunks.push("Rejected HTTP: " + site.negativeHttpCodes.join(", "));
        if (site.confirmationSignals.length) chunks.push("Confirmation: " + site.confirmationSignals.join(", "));
        if (site.correlationMethods.length) chunks.push("Correlation: " + site.correlationMethods.join(", "));
        if (site.providerRules.length) chunks.push("Provider: " + site.providerRules.join(", "));
        if (site.successMessages.length) chunks.push("Message: " + site.successMessages.join(" | "));
        if (site.rejectionMessages.length) chunks.push("Rejection: " + site.rejectionMessages.join(" | "));
        return chunks.join("; ") || "No selected signal details";
      }

      function selectSites(title, ids) {
        selectedIds = ids.slice();
        showAll = false;
        document.getElementById("selection-title").textContent = title;
        document.getElementById("selection-summary").textContent =
          ids.length + " website" + (ids.length === 1 ? "" : "s") + " in this selection";
        document.getElementById("show-all").textContent = ids.length > 12 ? "Show all" : "All shown";
        document.getElementById("show-all").disabled = ids.length <= 12;
        renderSiteTable();
      }

      function renderSiteTable() {
        const body = document.getElementById("site-table");
        body.replaceChildren();
        const ids = showAll ? selectedIds : selectedIds.slice(0, 12);
        ids.forEach(function (id) {
          const site = siteById.get(id);
          if (!site) return;
          const tr = document.createElement("tr");
          const idCell = document.createElement("td");
          idCell.textContent = site.id;
          const statusCell = document.createElement("td");
          const status = document.createElement("span");
          status.className = "status";
          status.textContent = site.status || "UNKNOWN";
          statusCell.appendChild(status);
          const urlCell = document.createElement("td");
          urlCell.textContent = site.websiteUrl || "—";
          const evidenceCell = document.createElement("td");
          evidenceCell.textContent = evidenceText(site);
          tr.append(idCell, statusCell, urlCell, evidenceCell);
          body.appendChild(tr);
        });
        if (!showAll && selectedIds.length > 12) {
          const tr = document.createElement("tr");
          const td = document.createElement("td");
          td.colSpan = 4;
          td.className = "muted";
          td.textContent = (selectedIds.length - 12) + " additional websites are hidden.";
          tr.appendChild(td);
          body.appendChild(tr);
        }
      }

      function polar(cx, cy, radius, angle) {
        const radians = (angle - 90) * Math.PI / 180;
        return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
      }

      function arcPath(cx, cy, inner, outer, start, end) {
        const safeEnd = end - 0.25;
        const outerStart = polar(cx, cy, outer, start);
        const outerEnd = polar(cx, cy, outer, safeEnd);
        const innerEnd = polar(cx, cy, inner, safeEnd);
        const innerStart = polar(cx, cy, inner, start);
        const large = safeEnd - start > 180 ? 1 : 0;
        return [
          "M", outerStart.x, outerStart.y,
          "A", outer, outer, 0, large, 1, outerEnd.x, outerEnd.y,
          "L", innerEnd.x, innerEnd.y,
          "A", inner, inner, 0, large, 0, innerStart.x, innerStart.y,
          "Z"
        ].join(" ");
      }

      function showTooltip(event, text) {
        const tooltip = document.getElementById("tooltip");
        tooltip.textContent = text;
        tooltip.classList.add("visible");
        const width = tooltip.offsetWidth;
        const height = tooltip.offsetHeight;
        tooltip.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX + 12)) + "px";
        tooltip.style.top = Math.max(8, Math.min(window.innerHeight - height - 8, event.clientY + 12)) + "px";
      }

      function hideTooltip() {
        document.getElementById("tooltip").classList.remove("visible");
      }

      function renderHttpChart() {
        const host = document.getElementById("http-chart");
        const svg = svgElement("svg", { viewBox: "0 0 440 440", width: "100%", height: "410" });
        const title = svgElement("title", {}, "HTTP evidence by polarity, response class, and exact code");
        const desc = svgElement("desc", {}, "Three concentric rings show positive and rejected network evidence, HTTP classes, and exact response codes.");
        svg.append(title, desc);
        const cx = 220;
        const cy = 220;
        const grandTotal = data.http.reduce(function (sum, group) { return sum + group.count; }, 0) || 1;
        let polarityStart = 0;
        data.http.forEach(function (polarity, polarityIndex) {
          if (!polarity.count) return;
          const polaritySweep = polarity.count / grandTotal * 360;
          const polarityEnd = polarityStart + polaritySweep;
          const polarityColor = polarity.key === "positive" ? "var(--positive)" : "var(--negative)";
          const polarityArc = svgElement("path", {
            d: arcPath(cx, cy, 62, 108, polarityStart, polarityEnd),
            fill: polarityColor,
            class: "arc",
            tabindex: "0",
            "data-key": polarity.key
          });
          const polarityTip = polarity.label + ": " + polarity.count + " websites";
          polarityArc.addEventListener("mousemove", function (event) { showTooltip(event, polarityTip); });
          polarityArc.addEventListener("mouseleave", hideTooltip);
          polarityArc.addEventListener("click", function () { selectSites(polarity.label, polarity.siteIds); });
          polarityArc.addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " ") selectSites(polarity.label, polarity.siteIds);
          });
          svg.appendChild(polarityArc);

          let classStart = polarityStart;
          polarity.classes.forEach(function (group, classIndex) {
            if (!group.count) return;
            const classSweep = polaritySweep * group.count / polarity.count;
            const classEnd = classStart + classSweep;
            const classColor =
              polarity.key === "negative"
                ? "var(--negative-soft)"
                : group.label === "3XX"
                  ? "var(--redirect)"
                  : "var(--positive-soft)";
            const classArc = svgElement("path", {
              d: arcPath(cx, cy, 110, 158, classStart, classEnd),
              fill: classColor,
              class: "arc",
              tabindex: "0"
            });
            const classTip = polarity.label + " / " + group.label + ": " + group.count;
            classArc.addEventListener("mousemove", function (event) { showTooltip(event, classTip); });
            classArc.addEventListener("mouseleave", hideTooltip);
            classArc.addEventListener("click", function () { selectSites(group.label + " " + polarity.label.toLowerCase(), group.siteIds); });
            classArc.addEventListener("keydown", function (event) {
              if (event.key === "Enter" || event.key === " ") selectSites(group.label, group.siteIds);
            });
            svg.appendChild(classArc);

            let codeStart = classStart;
            group.codes.forEach(function (code, codeIndex) {
              const codeSweep = classSweep * code.count / group.count;
              const codeEnd = codeStart + codeSweep;
              const opacity = 0.48 + (codeIndex % 3) * 0.17;
              const codeArc = svgElement("path", {
                d: arcPath(cx, cy, 160, 207, codeStart, codeEnd),
                fill: polarityColor,
                opacity: String(opacity),
                class: "arc",
                tabindex: "0"
              });
              const codeTip = "HTTP " + code.code + ": " + code.count + " — " + code.description;
              codeArc.addEventListener("mousemove", function (event) { showTooltip(event, codeTip); });
              codeArc.addEventListener("mouseleave", hideTooltip);
              codeArc.addEventListener("click", function () { selectSites("HTTP " + code.code, code.siteIds); });
              codeArc.addEventListener("keydown", function (event) {
                if (event.key === "Enter" || event.key === " ") selectSites("HTTP " + code.code, code.siteIds);
              });
              svg.appendChild(codeArc);
              if (codeSweep >= 17) {
                const middle = codeStart + codeSweep / 2;
                const point = polar(cx, cy, 183, middle);
                const codeLabel = svgElement("text", {
                  x: point.x.toFixed(2),
                  y: point.y.toFixed(2),
                  "text-anchor": "middle",
                  "dominant-baseline": "central",
                  "font-size": "12",
                  "font-weight": "650",
                  "pointer-events": "none"
                }, code.code);
                svg.appendChild(codeLabel);
              }
              codeStart = codeEnd;
            });
            classStart = classEnd;
          });
          polarityStart = polarityEnd;
        });
        svg.appendChild(svgElement("text", {
          x: cx,
          y: cy - 7,
          "text-anchor": "middle",
          "font-size": "14",
          fill: "var(--muted)"
        }, "Network evidence"));
        svg.appendChild(svgElement("text", {
          x: cx,
          y: cy + 17,
          "text-anchor": "middle",
          "font-size": "18",
          "font-weight": "650"
        }, data.http[0].count + " positive"));
        svg.appendChild(svgElement("text", {
          x: cx,
          y: cy + 39,
          "text-anchor": "middle",
          "font-size": "14",
          fill: "var(--muted)"
        }, data.http[1].count + " rejected"));
        host.appendChild(svg);
      }

      function renderHttpList() {
        const host = document.getElementById("http-list");
        data.http.forEach(function (polarity) {
          polarity.classes.forEach(function (group) {
            group.codes.forEach(function (code) {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "http-row";
              const top = document.createElement("span");
              top.className = "topline";
              const label = document.createElement("strong");
              label.textContent = (code.code === "request_failed" ? "Transport failure" : "HTTP " + code.code) +
                " · " + polarity.label;
              const count = document.createElement("span");
              count.textContent = code.count;
              top.append(label, count);
              const meaning = document.createElement("span");
              meaning.className = "meaning";
              meaning.textContent = code.description;
              button.append(top, meaning);
              button.addEventListener("click", function () { selectSites("HTTP " + code.code, code.siteIds); });
              host.appendChild(button);
            });
          });
        });
      }

      function renderBars() {
        const host = document.getElementById("correlation-bars");
        const max = Math.max.apply(null, data.correlations.map(function (row) { return row.count; }).concat([1]));
        data.correlations.forEach(function (row) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "bar-row";
          const label = document.createElement("span");
          label.className = "bar-label";
          const name = document.createElement("strong");
          name.textContent = row.label;
          const count = document.createElement("span");
          count.textContent = row.count;
          label.append(name, count);
          const track = document.createElement("span");
          track.className = "bar-track";
          const fill = document.createElement("span");
          fill.className = "bar-fill";
          fill.style.width = (row.count / max * 100).toFixed(2) + "%";
          track.appendChild(fill);
          const description = document.createElement("span");
          description.className = "meaning";
          description.textContent = row.description;
          button.append(label, track, description);
          button.addEventListener("click", function () { selectSites(row.label, row.siteIds); });
          host.appendChild(button);
        });
      }

      function renderProviders() {
        const host = document.getElementById("provider-list");
        if (!data.providers.length) {
          host.textContent = "No provider-specific evidence.";
          host.className += " muted small";
          return;
        }
        data.providers.forEach(function (row) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "http-row provider-line";
          const label = document.createElement("span");
          label.textContent = row.label;
          const count = document.createElement("strong");
          count.textContent = row.count;
          button.append(label, count);
          button.addEventListener("click", function () { selectSites(row.label, row.siteIds); });
          host.appendChild(button);
        });
      }

      function renderUpSet() {
        const host = document.getElementById("upset-chart");
        const signals = data.signalDefinitions;
        const combos = data.intersections;
        if (!combos.length) {
          host.textContent = "No positive signal combinations were recorded.";
          host.className = "muted";
          return;
        }
        const left = 210;
        const top = 30;
        const barHeight = 170;
        const matrixTop = top + barHeight + 35;
        const rowHeight = 38;
        const columnWidth = Math.max(72, Math.min(118, (1040 - left) / combos.length));
        const width = Math.max(760, left + combos.length * columnWidth + 25);
        const height = matrixTop + signals.length * rowHeight + 35;
        const maxCount = Math.max.apply(null, combos.map(function (combo) { return combo.count; }));
        const svg = svgElement("svg", { viewBox: "0 0 " + width + " " + height, width: "100%", height: String(height) });
        svg.append(
          svgElement("title", {}, "Exact positive-signal combinations"),
          svgElement("desc", {}, "Bars give website counts. Filled connected dots identify the exact signals present in each combination.")
        );
        signals.forEach(function (signal, rowIndex) {
          const y = matrixTop + rowIndex * rowHeight;
          svg.appendChild(svgElement("text", {
            x: 0,
            y: y + 5,
            "font-size": "13",
            "dominant-baseline": "middle"
          }, signal.label));
          svg.appendChild(svgElement("line", {
            x1: left - 10,
            x2: width,
            y1: y,
            y2: y,
            stroke: "var(--grid)",
            "stroke-width": "1"
          }));
        });
        combos.forEach(function (combo, columnIndex) {
          const x = left + columnIndex * columnWidth + columnWidth / 2;
          const bar = maxCount === 0 ? 0 : combo.count / maxCount * barHeight;
          const group = svgElement("g", {
            class: "upset-column",
            tabindex: "0",
            role: "button",
            "aria-label": combo.label + ": " + combo.count + " websites"
          });
          group.appendChild(svgElement("rect", {
            x: x - columnWidth * .28,
            y: top + barHeight - bar,
            width: columnWidth * .56,
            height: bar,
            rx: "4",
            fill: "var(--accent)",
            class: "upset-bar"
          }));
          group.appendChild(svgElement("text", {
            x: x,
            y: top + barHeight - bar - 8,
            "text-anchor": "middle",
            "font-size": "14",
            "font-weight": "650"
          }, String(combo.count)));
          const activeRows = [];
          signals.forEach(function (signal, rowIndex) {
            if (combo.signalKeys.includes(signal.key)) activeRows.push(rowIndex);
          });
          if (activeRows.length > 1) {
            group.appendChild(svgElement("line", {
              x1: x,
              x2: x,
              y1: matrixTop + activeRows[0] * rowHeight,
              y2: matrixTop + activeRows[activeRows.length - 1] * rowHeight,
              stroke: "var(--text)",
              "stroke-width": "3"
            }));
          }
          signals.forEach(function (signal, rowIndex) {
            const active = combo.signalKeys.includes(signal.key);
            group.appendChild(svgElement("circle", {
              cx: x,
              cy: matrixTop + rowIndex * rowHeight,
              r: active ? "7" : "5",
              fill: active ? "var(--text)" : "var(--grid)"
            }));
          });
          group.addEventListener("click", function () { selectSites(combo.label, combo.siteIds); });
          group.addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " ") selectSites(combo.label, combo.siteIds);
          });
          group.addEventListener("mousemove", function (event) {
            showTooltip(event, combo.label + ": " + combo.count + " websites");
          });
          group.addEventListener("mouseleave", hideTooltip);
          svg.appendChild(group);
        });
        host.appendChild(svg);
      }

      function renderMessages() {
        const host = document.getElementById("message-list");
        if (!data.successMessages.length) {
          host.textContent = "No contained success-message variants were available.";
          host.className += " muted small";
          return;
        }
        data.successMessages.forEach(function (row) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "message-row";
          const count = document.createElement("span");
          count.className = "message-count";
          count.textContent = row.count;
          const message = document.createElement("span");
          message.textContent = row.label;
          button.append(count, message);
          button.addEventListener("click", function () { selectSites("Visible message: " + row.label, row.siteIds); });
          host.appendChild(button);
        });
      }

      setText("generated-at", "Generated " + data.generatedAt + " · signal rulebook " + data.rulebookVersion);
      setText("attempt-count", data.denominators.submissionAttempts);
      setText("positive-count", data.denominators.positive);
      setText("negative-count", data.denominators.negative);
      setText("overlap-count", data.denominators.overlap);
      setText("processed-count", data.denominators.processed);
      renderHttpChart();
      renderHttpList();
      renderBars();
      renderProviders();
      renderUpSet();
      renderMessages();
      const initial = data.intersections[0];
      if (initial) selectSites(initial.label, initial.siteIds);
      else selectSites("Positive evidence", []);
      document.getElementById("show-all").addEventListener("click", function () {
        showAll = true;
        document.getElementById("show-all").disabled = true;
        document.getElementById("show-all").textContent = "All shown";
        renderSiteTable();
      });
      root.setAttribute("data-ready", "true");
    }());
  </script>
</body>
</html>
`;
};

const signalDashboardPngCache = new Map<string, Promise<Buffer>>();

const renderSignalDashboardPngUncached = async (html: string): Promise<Buffer> => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "contact-form-signal-dashboard-"));
  const htmlPath = path.join(temporaryDirectory, "signal-dashboard.html");
  const pngPath = path.join(temporaryDirectory, "signal-dashboard.png");
  let browser: Browser | undefined;
  try {
    await writeFile(htmlPath, html, "utf8");
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1400 },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.waitForSelector("#signal-dashboard[data-ready='true']");
    await page.screenshot({
      path: pngPath,
      fullPage: true,
      animations: "disabled",
    });
    return await readFile(pngPath);
  } finally {
    await browser?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

export const renderSignalDashboardPng = async (html: string): Promise<Buffer> => {
  const cached = signalDashboardPngCache.get(html);
  if (cached) return Buffer.from(await cached);
  const rendering = renderSignalDashboardPngUncached(html);
  signalDashboardPngCache.set(html, rendering);
  try {
    return Buffer.from(await rendering);
  } catch (error) {
    signalDashboardPngCache.delete(html);
    throw error;
  }
};
