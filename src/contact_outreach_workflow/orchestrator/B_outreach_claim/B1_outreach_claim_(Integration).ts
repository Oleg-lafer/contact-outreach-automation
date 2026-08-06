import type {
  ClaimOutreachInput,
  OutreachClaimResult,
  OutreachHistoryStore,
} from "../../shared_files_orchestrator/outreach_history_types_(Support).js";

export async function claim_outreach_before_browser(
  store: OutreachHistoryStore,
  input: ClaimOutreachInput,
): Promise<OutreachClaimResult> {
  return store.claimOutreach(input);
}
