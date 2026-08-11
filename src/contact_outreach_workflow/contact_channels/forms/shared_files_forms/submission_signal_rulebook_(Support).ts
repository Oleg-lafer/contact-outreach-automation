import { readFileSync } from "node:fs";
import { z } from "zod";

const atomic_score_schema = z.number().int().min(-3).max(3).refine(
  (score) => score !== 0,
  "Scoreable signals cannot use zero.",
);

const confirmation_evidence_schema = z.object({
  kind: z.literal("confirmation"),
  source: z.enum([
    "visibleEvidence.confirmationEvidence",
    "stagehandEvidence",
  ]),
  equals: z.enum(["successText", "successUrl", "aiVisibleText"]),
});

const rejection_evidence_schema = z.object({
  kind: z.literal("rejectionCategory"),
  source: z.literal("visibleEvidence.rejectionEvidence"),
  category: z.enum(["validation", "captcha", "server", "generic"]),
  allowedEvidenceSources: z.array(z.literal("visibleMessage")).min(1),
});

const boolean_evidence_schema = z.object({
  kind: z.literal("boolean"),
  source: z.literal("captchaBlocked"),
  equals: z.literal(true),
});

const network_variant_schema = z
  .object({
    id: z.string().min(1),
    priority: z.number().int(),
    score: atomic_score_schema,
    statusMinimum: z.number().int().min(100).max(599).optional(),
    statusMaximum: z.number().int().min(100).max(599).optional(),
    status: z.literal("missing").optional(),
    providerRule: z.enum(["present", "any"]),
  })
  .superRefine((variant, context) => {
    const has_range =
      variant.statusMinimum !== undefined && variant.statusMaximum !== undefined;
    const expects_missing = variant.status === "missing";
    if (has_range === expects_missing) {
      context.addIssue({
        code: "custom",
        message: "A network variant must define either a status range or status=missing.",
      });
    }
    if (
      has_range &&
      variant.statusMinimum !== undefined &&
      variant.statusMaximum !== undefined &&
      variant.statusMinimum > variant.statusMaximum
    ) {
      context.addIssue({
        code: "custom",
        message: "statusMinimum must not exceed statusMaximum.",
      });
    }
  });

const common_signal_schema = z.object({
  id: z.string().min(1),
  polarity: z.enum(["positive", "negative"]),
  family: z.string().min(1),
  dedupeGroup: z.string().min(1),
  description: z.string().min(1),
});

const fixed_signal_schema = common_signal_schema.extend({
  scoring: z.literal("fixed"),
  score: atomic_score_schema,
  evidence: z.discriminatedUnion("kind", [
    confirmation_evidence_schema,
    rejection_evidence_schema,
    boolean_evidence_schema,
  ]),
});

const network_signal_schema = common_signal_schema.extend({
  scoring: z.literal("variants"),
  evidence: z.object({
    kind: z.literal("network"),
    source: z.literal("networkEvidence"),
    outcomeField: z.enum(["confirmsSubmission", "rejectsSubmission"]),
    requestSelection: z.enum([
      "bestRequest",
      "bestRejectionRequestThenBestRequest",
    ]),
  }),
  variants: z.array(network_variant_schema).min(1),
});

export const submission_signal_rulebook_schema = z
  .object({
    schemaVersion: z.literal(1),
    rulebookVersion: z.string().min(1),
    status: z.enum(["draft", "active", "retired"]),
    scope: z.string().min(1),
    sourceContract: z.object({
      inputType: z.literal("AuthoritativeSubmissionEvidenceInput"),
      typeFile: z.string().min(1),
      assessmentFile: z.string().min(1),
      messageClassificationOwner: z.string().min(1),
      networkClassificationOwner: z.string().min(1),
      principle: z.string().min(1),
    }),
    scoreScale: z.object({
      minimumAtomicScore: z.literal(-3),
      maximumAtomicScore: z.literal(3),
      neutralScore: z.literal(0),
      levels: z.record(z.string(), z.string().min(1)),
    }),
    classification: z.object({
      positive: z.object({
        condition: z.literal("totalScore > 0"),
        classification: z.literal("success"),
        displayTemplate: z.literal("Success {totalScore}"),
      }),
      negative: z.object({
        condition: z.literal("totalScore < 0"),
        classification: z.literal("failure"),
        displayTemplate: z.literal("Failure {totalScore}"),
      }),
      zero: z.object({
        condition: z.literal("totalScore === 0"),
        classification: z.literal("inconclusive"),
        displayTemplate: z.literal("Inconclusive"),
      }),
      preservePolarityFlags: z.literal(true),
    }),
    signals: z
      .array(z.discriminatedUnion("scoring", [fixed_signal_schema, network_signal_schema]))
      .min(10),
    deduplication: z.object({
      oneScorePerSignalPerAttempt: z.literal(true),
      groupResolution: z.array(
        z.object({
          group: z.string().min(1),
          strategy: z.enum([
            "highest_positive_score",
            "lowest_negative_score",
            "highest_priority_variant",
          ]),
        }),
      ),
      metadataNotScoredSeparately: z.array(z.string().min(1)),
    }),
    neutralEvidence: z.array(z.string().min(1)),
    aggregation: z.object({
      operation: z.literal("sum"),
      input: z.string().min(1),
      output: z.literal("totalScore"),
      derive: z.object({
        hasPositiveSignals: z.string().min(1),
        hasNegativeSignals: z.string().min(1),
        hasBothPolarities: z.string().min(1),
      }),
    }),
  })
  .superRefine((rulebook, context) => {
    const ids = rulebook.signals.map((signal) => signal.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Signal IDs must be unique." });
    }
    const required_ids = [
      "visible_success_text", "success_url", "ai_verified_visible_success",
      "network_confirmation", "validation_rejection", "captcha_rejection",
      "captcha_blocked", "server_rejection", "generic_rejection", "network_rejection",
    ];
    for (const required_id of required_ids) {
      if (!ids.includes(required_id)) {
        context.addIssue({ code: "custom", message: `Required signal ${required_id} is missing.` });
      }
    }
    for (const signal of rulebook.signals) {
      const scores =
        signal.scoring === "fixed"
          ? [signal.score]
          : signal.variants.map((variant) => variant.score);
      if (
        scores.some(
          (score) =>
            (signal.polarity === "positive" && score < 0) ||
            (signal.polarity === "negative" && score > 0),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: `Signal ${signal.id} has a score inconsistent with its polarity.`,
        });
      }
    }
  });

export type SubmissionSignalRulebook = z.infer<
  typeof submission_signal_rulebook_schema
>;
export type SubmissionSignalDefinition = SubmissionSignalRulebook["signals"][number];

const rulebook_url = new URL("../submission_signal_rulebook.json", import.meta.url);

export function load_submission_signal_rulebook(): SubmissionSignalRulebook {
  const parsed_json: unknown = JSON.parse(readFileSync(rulebook_url, "utf8"));
  return submission_signal_rulebook_schema.parse(parsed_json);
}

export const submission_signal_rulebook = load_submission_signal_rulebook();
