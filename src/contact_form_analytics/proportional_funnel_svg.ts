import type { AnalyticsResult, StageStatistics } from "./analytics_types.js";

/** A single branching level in the proportional workflow tree. */
interface TreeLevel {
  label: string;
  denominatorLabel: string;
  denominator: number;
  success: number;
  clearFailure: number;
  unclear: number;
  finalSuccess: boolean;
}

interface OutcomeSquare {
  category: "success" | "failure" | "unclear";
  label: string;
  count: number;
  color: string;
  centerX: number;
  centerY: number;
  labelPlacement: "below" | "left";
}

const COLORS = {
  success: "#16a34a",
  failure: "#dc2626",
  unclear: "#6b7280",
  stage: "#2563eb",
  text: "#111827",
  muted: "#4b5563",
  line: "#94a3b8",
} as const;

const escapeXml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const percentage = (count: number, denominator: number): number =>
  denominator === 0 ? 0 : (count / denominator) * 100;

/**
 * Area, not width, represents percentage. Since square area is side squared,
 * the square-root transform makes rendered area exactly proportional to c / d.
 */
const squareSide = (count: number, denominator: number, maximumSide: number): number =>
  denominator === 0 || count === 0 ? 0 : maximumSide * Math.sqrt(count / denominator);

const ordinaryLevel = (stage: StageStatistics, label: string): TreeLevel => ({
  label,
  denominatorLabel: "entered",
  denominator: stage.entered,
  success: stage.advancedOrQualifiedOrCompleted,
  clearFailure: Math.max(0, stage.stopped - stage.attribution.indeterminate.count),
  unclear: stage.attribution.indeterminate.count + stage.incomplete,
  finalSuccess: false,
});

/**
 * Build the actual workflow spine. Reporting evidence is positioned before the
 * Browser level because incomplete directories have no terminal artifact and
 * therefore cannot defensibly enter the responsibility funnel.
 */
const buildLevels = (result: AnalyticsResult): TreeLevel[] => {
  const stage = (name: StageStatistics["stage"]): StageStatistics => {
    const found = result.stages.find((candidate) => candidate.stage === name);
    if (!found) throw new Error(`Missing ${name} stage statistics.`);
    return found;
  };
  const input = ordinaryLevel(stage("input"), "Input");
  const reporting = stage("reporting");
  const browser = ordinaryLevel(stage("browser"), "Browser");
  const discovery = ordinaryLevel(stage("discovery"), "Discovery");
  const population = ordinaryLevel(stage("population"), "Population");
  const submission = ordinaryLevel(stage("submission"), "Submission");
  submission.finalSuccess = true;
  return [
    input,
    {
      label: "Reporting evidence",
      denominatorLabel: "processed",
      denominator: result.counts.processed,
      success: result.counts.terminalResults,
      clearFailure: reporting.stopped,
      unclear: result.counts.incomplete,
      finalSuccess: false,
    },
    browser,
    discovery,
    population,
    submission,
  ];
};

const renderSquare = (
  definition: OutcomeSquare,
  denominator: number,
  maximumSide: number,
): { markup: string[]; side: number } => {
  const side = squareSide(definition.count, denominator, maximumSide);
  const x = definition.centerX - side / 2;
  const y = definition.centerY - side / 2;
  const pct = percentage(definition.count, denominator);
  const showCountInside = side >= 42 && definition.count > 0;
  const labelMarkup =
    definition.labelPlacement === "left"
      ? [
          `  <text x="${definition.centerX - maximumSide / 2 - 18}" y="${definition.centerY - 5}" class="outcome-label-left">${escapeXml(definition.label)}</text>`,
          `  <text x="${definition.centerX - maximumSide / 2 - 18}" y="${definition.centerY + 17}" class="outcome-value-left">${definition.count} (${pct.toFixed(2)}%)</text>`,
        ]
      : [
          `  <text x="${definition.centerX}" y="${definition.centerY + maximumSide / 2 + 25}" class="outcome-label">${escapeXml(definition.label)}</text>`,
          `  <text x="${definition.centerX}" y="${definition.centerY + maximumSide / 2 + 46}" class="outcome-value">${definition.count} (${pct.toFixed(2)}%)</text>`,
        ];
  return {
    side,
    markup: [
      `  <rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${side.toFixed(2)}" height="${side.toFixed(2)}" rx="4" fill="${definition.color}" data-category="${definition.category}" data-count="${definition.count}" data-percentage="${pct.toFixed(2)}"/>`,
      ...(showCountInside
        ? [`  <text x="${definition.centerX}" y="${definition.centerY + 6}" class="square-value">${definition.count}</text>`]
        : []),
      ...labelMarkup,
    ],
  };
};

/**
 * Render a genuine branching SVG tree.
 *
 * The green success branch continues down the central workflow spine. Every
 * failure branch terminates to the right and splits into a red deterministic
 * failure leaf and a gray indeterminate/incomplete leaf. Native SVG keeps the
 * normal Node analyzer dependency-free while remaining scalable and printable.
 */
export const renderProportionalFunnelSvg = (result: AnalyticsResult): string => {
  const levels = buildLevels(result);
  const width = 1380;
  const top = 190;
  const levelHeight = 300;
  const maximumSide = 128;
  const height = top + levels.length * levelHeight + 90;
  const trunkX = 235;
  const stageWidth = 300;
  const stageHeight = 76;
  const junctionX = 610;
  const redX = 870;
  const grayX = 1190;
  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">`,
    "  <title id=\"title\">Branching contact-form workflow tree with proportional outcome squares</title>",
    "  <desc id=\"description\">The green success branch continues downward through workflow stages. Red clear failures and gray indeterminate outcomes branch right and terminate. Every square area is proportional to its percentage within that stage.</desc>",
    "  <defs>",
    `    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${COLORS.line}"/></marker>`,
    "    <style>",
    `      text { font-family: Inter, Segoe UI, Arial, sans-serif; fill: ${COLORS.text}; }`,
    "      .title { font-size: 28px; font-weight: 500; }",
    `      .subtitle { font-size: 15px; fill: ${COLORS.muted}; }`,
    "      .stage-label { font-size: 19px; font-weight: 500; fill: white; text-anchor: middle; }",
    "      .stage-count { font-size: 13px; fill: white; text-anchor: middle; }",
    "      .outcome-label { font-size: 15px; font-weight: 500; text-anchor: middle; }",
    `      .outcome-value { font-size: 14px; fill: ${COLORS.muted}; text-anchor: middle; }`,
    "      .outcome-label-left { font-size: 15px; font-weight: 500; text-anchor: end; }",
    `      .outcome-value-left { font-size: 14px; fill: ${COLORS.muted}; text-anchor: end; }`,
    "      .square-value { font-size: 16px; font-weight: 500; fill: white; text-anchor: middle; }",
    `      .branch { fill: none; stroke: ${COLORS.line}; stroke-width: 2; }`,
    `      .branch-label { font-size: 13px; fill: ${COLORS.muted}; text-anchor: middle; }`,
    "      .legend { font-size: 14px; dominant-baseline: middle; }",
    "    </style>",
    "  </defs>",
    "  <text x=\"40\" y=\"45\" class=\"title\">Contact-form workflow: proportional outcome tree</text>",
    `  <text x="40" y="72" class="subtitle">Generated ${escapeXml(result.generatedAt)} | Square area represents percentage (not side length)</text>`,
    `  <rect x="40" y="98" width="16" height="16" fill="${COLORS.success}"/><text x="64" y="106" class="legend">Success branch continues</text>`,
    `  <rect x="260" y="98" width="16" height="16" fill="${COLORS.failure}"/><text x="284" y="106" class="legend">Clear failure leaf</text>`,
    `  <rect x="445" y="98" width="16" height="16" fill="${COLORS.unclear}"/><text x="469" y="106" class="legend">Indeterminate / incomplete leaf</text>`,
  ];

  levels.forEach((level, index) => {
    const stageY = top + index * levelHeight;
    const successY = stageY + 125;
    const successLabel = level.finalSuccess ? "Confirmed success" : "Success / advance";
    const success = renderSquare(
      {
        category: "success",
        label: successLabel,
        count: level.success,
        color: COLORS.success,
        centerX: trunkX,
        centerY: successY,
        labelPlacement: "left",
      },
      level.denominator,
      maximumSide,
    );
    const failure = renderSquare(
      {
        category: "failure",
        label: "Clear failure",
        count: level.clearFailure,
        color: COLORS.failure,
        centerX: redX,
        centerY: stageY,
        labelPlacement: "below",
      },
      level.denominator,
      maximumSide,
    );
    const unclear = renderSquare(
      {
        category: "unclear",
        label: "Not clear",
        count: level.unclear,
        color: COLORS.unclear,
        centerX: grayX,
        centerY: stageY,
        labelPlacement: "below",
      },
      level.denominator,
      maximumSide,
    );

    const stageLeft = trunkX - stageWidth / 2;
    const stageTop = stageY - stageHeight / 2;
    const successTop = successY - success.side / 2;
    lines.push(
      `  <rect x="${stageLeft}" y="${stageTop}" width="${stageWidth}" height="${stageHeight}" rx="8" fill="${COLORS.stage}"/>`,
      `  <text x="${trunkX}" y="${stageY - 7}" class="stage-label">${escapeXml(level.label)}</text>`,
      `  <text x="${trunkX}" y="${stageY + 17}" class="stage-count">${level.denominatorLabel}: ${level.denominator}</text>`,
      `  <path d="M ${trunkX} ${stageY + stageHeight / 2} V ${(successTop - 8).toFixed(2)}" class="branch" marker-end="url(#arrow)"/>`,
      `  <text x="${trunkX + 74}" y="${stageY + 67}" class="branch-label">Success ${percentage(level.success, level.denominator).toFixed(2)}%</text>`,
      `  <path d="M ${trunkX + stageWidth / 2} ${stageY} H ${junctionX}" class="branch"/>`,
      `  <circle cx="${junctionX}" cy="${stageY}" r="5" fill="${COLORS.line}"/>`,
      `  <text x="${(trunkX + stageWidth / 2 + junctionX) / 2}" y="${stageY - 12}" class="branch-label">Failure / unclear</text>`,
      `  <path d="M ${junctionX} ${stageY} H ${(redX - failure.side / 2 - 8).toFixed(2)}" class="branch" marker-end="url(#arrow)"/>`,
      `  <path d="M ${junctionX} ${stageY} C ${junctionX + 100} ${stageY + 85}, ${grayX - 170} ${stageY + 85}, ${(grayX - unclear.side / 2 - 8).toFixed(2)} ${stageY}" class="branch" marker-end="url(#arrow)"/>`,
      ...success.markup,
      ...failure.markup,
      ...unclear.markup,
    );

    if (!level.finalSuccess && index < levels.length - 1) {
      const nextStageY = top + (index + 1) * levelHeight;
      const successBottom = successY + success.side / 2;
      lines.push(
        `  <path d="M ${trunkX} ${successBottom.toFixed(2)} V ${nextStageY - stageHeight / 2 - 8}" class="branch" marker-end="url(#arrow)"/>`,
      );
    }
  });

  lines.push("</svg>", "");
  return lines.join("\n");
};
