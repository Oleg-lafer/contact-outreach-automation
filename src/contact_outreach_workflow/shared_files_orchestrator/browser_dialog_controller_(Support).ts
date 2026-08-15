import type { Dialog, Page } from "playwright";
import type { DeepDebugContext } from "./deep_debug_types_(Support).js";
import type { BrowserDialogController, BrowserDialogRecord } from "./outreach_types_(Support).js";

const MAX_DIALOG_RECORDS = 50;
const MAX_DIALOG_MESSAGE_LENGTH = 500;

export function create_browser_dialog_controller(options: {
  deepDebug?: DeepDebugContext;
  redactionValues?: readonly string[];
} = {}): BrowserDialogController {
  const records: BrowserDialogRecord[] = [];
  const listeners = new Map<Page, (dialog: Dialog) => void>();
  let submit_depth = 0;
  let sequence = 0;

  return {
    beginSubmit: () => {
      submit_depth++;
      return sequence;
    },
    endSubmit: () => { submit_depth = Math.max(0, submit_depth - 1); },
    recordsSince: (after) => records.filter((record) => record.sequence > after),
    attach: (page) => {
      if (listeners.has(page)) return;
      const listener = (dialog: Dialog): void => {
        const phase = submit_depth > 0 ? "submit" : "browsing";
        const action = dialog.type() === "confirm" && phase === "submit" ? "accept" : "dismiss";
        const record: BrowserDialogRecord = {
          sequence: ++sequence,
          timestamp: new Date().toISOString(),
          type: dialog.type() as BrowserDialogRecord["type"],
          message: redact_and_bound(dialog.message(), options.redactionValues ?? []),
          pageUrl: safe_page_url(page),
          phase,
          action,
          result: "handled",
        };
        records.push(record);
        if (records.length > MAX_DIALOG_RECORDS) records.shift();
        void (action === "accept" ? dialog.accept() : dialog.dismiss())
          .then(() => record_dialog(options.deepDebug, record))
          .catch((error: unknown) => {
            record.result = "failed";
            record.error = redact_and_bound(error instanceof Error ? error.message : String(error), options.redactionValues ?? []);
            record_dialog(options.deepDebug, record);
          });
      };
      listeners.set(page, listener);
      page.on("dialog", listener);
    },
    detachAll: () => {
      for (const [page, listener] of listeners) page.off("dialog", listener);
      listeners.clear();
    },
  };
}

function record_dialog(deep_debug: DeepDebugContext | undefined, record: BrowserDialogRecord): void {
  deep_debug?.record({
    stage: "runtime", substage: "dialog", operation: "handle-native-dialog",
    outcome: record.result === "handled" ? "succeeded" : "failed",
    ...(record.error ? { reason: record.error } : {}), url: record.pageUrl, data: record,
  });
}

function redact_and_bound(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[redacted-contact-value]");
  }
  return result.replace(/\s+/g, " ").trim().slice(0, MAX_DIALOG_MESSAGE_LENGTH);
}

function safe_page_url(page: Page): string {
  try { return page.url(); } catch { return ""; }
}
