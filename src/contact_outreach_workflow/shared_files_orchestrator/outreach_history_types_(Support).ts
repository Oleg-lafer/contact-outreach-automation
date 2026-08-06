import type { ContactOutreachOutcome } from "./outreach_types_(Support).js";

export interface OutreachSenderDetails {
  name: string;
  email: string;
  phone: string;
  company: string;
  role: string;
  website: string;
  country: string;
}

export interface OutreachCampaign {
  campaignId: number;
  senderDetails: OutreachSenderDetails;
  messageToSend: string;
  preventResend: boolean;
}

export type OutreachExecutionStatus = "finished" | "run_failed" | "skipped";
export type OutreachChannelResult =
  | "success"
  | "partial"
  | "inconclusive"
  | "failed";

export type OutreachClaimResult =
  | {
      action: "run";
      attemptId: number;
      websiteId: number;
      normalizedDomain: string;
    }
  | {
      action: "skip";
      attemptId: number;
      websiteId: number;
      normalizedDomain: string;
      reason: string;
    };

export interface ClaimOutreachInput {
  campaignId: number;
  websiteUrl: string;
}

export interface CompleteOutreachAttemptInput {
  attemptId: number;
  outcome: ContactOutreachOutcome;
}

export interface OutreachHistoryStore {
  claimOutreach(input: ClaimOutreachInput): Promise<OutreachClaimResult>;
  completeAttempt(input: CompleteOutreachAttemptInput): Promise<void>;
  close(): Promise<void>;
}
