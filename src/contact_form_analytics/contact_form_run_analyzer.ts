import { analyzeRun } from "./run_analyzer.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

export { analyzeRun } from "./run_analyzer.js";

const incompleteDiscoveryCount = (counts: {
  outcomes: {
    found_partial: { count: number };
    incomplete: { count: number };
    execution_failed: { count: number };
    artifact_incomplete: { count: number };
    conflicting: { count: number };
  };
}): number =>
  counts.outcomes.found_partial.count +
  counts.outcomes.incomplete.count +
  counts.outcomes.execution_failed.count +
  counts.outcomes.artifact_incomplete.count +
  counts.outcomes.conflicting.count;

const main = async (): Promise<void> => {
  const runPath = process.argv[2]?.trim();
  if (!runPath) {
    console.error('Usage: npm run analyze -- "<run-path>"');
    process.exitCode = 2;
    return;
  }
  try {
    const outcome = await analyzeRun(runPath);
    const { result } = outcome;
    const { forms, emails, meetings } = result.channels;
    console.log(`Analyzed ${result.processed} site director${result.processed === 1 ? "y" : "ies"}.`);
    console.log(`Detected mode: ${result.runMode}`);
    console.log(
      `Forms — completed: ${forms.counts.completed}; qualified: ${forms.counts.qualified}; stopped: ${forms.counts.stopped}; incomplete: ${forms.counts.incomplete}.`,
    );
    console.log(
      `Emails — found complete: ${emails.counts.outcomes.found_complete.count}; no opportunity: ${emails.counts.outcomes.no_opportunity.count}; incomplete/error: ${incompleteDiscoveryCount(emails.counts)}.`,
    );
    console.log(
      `Meetings — found complete: ${meetings.counts.outcomes.found_complete.count}; no opportunity: ${meetings.counts.outcomes.no_opportunity.count}; incomplete/error: ${incompleteDiscoveryCount(meetings.counts)}.`,
    );
    if (outcome.latestDirectory) console.log(`Latest report: ${outcome.latestDirectory}`);
    if (outcome.historyDirectory) console.log(`History report: ${outcome.historyDirectory}`);
  } catch (error) {
    console.error(`Analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false;
if (invokedDirectly) void main();
