import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const gunzip_async = promisify(gunzip);

export interface DeepDebugTimelineSelection {
  path: string;
  text: string;
}

export async function read_deep_debug_timeline(
  artifact_directory: string,
): Promise<DeepDebugTimelineSelection | undefined> {
  const compressed_path = join(artifact_directory, "timeline.jsonl.gz");
  try {
    const compressed = await readFile(compressed_path);
    return {
      path: compressed_path,
      text: (await gunzip_async(compressed)).toString("utf8"),
    };
  } catch (error) {
    if (!is_missing_file(error)) throw error;
  }

  const plain_path = join(artifact_directory, "timeline.jsonl");
  try {
    return { path: plain_path, text: await readFile(plain_path, "utf8") };
  } catch (error) {
    if (is_missing_file(error)) return undefined;
    throw error;
  }
}

export async function read_deep_debug_stage_events(
  artifact_directory: string,
  stage: string,
): Promise<DeepDebugTimelineSelection | undefined> {
  const legacy_path = join(artifact_directory, stage, "events.jsonl");
  try {
    return { path: legacy_path, text: await readFile(legacy_path, "utf8") };
  } catch (error) {
    if (!is_missing_file(error)) throw error;
  }

  const timeline = await read_deep_debug_timeline(artifact_directory);
  if (!timeline) return undefined;
  const selected_lines: string[] = [];
  for (const line of timeline.text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { stage?: unknown };
      if (event.stage === stage) selected_lines.push(line);
    } catch {
      selected_lines.push(line);
    }
  }
  return {
    path: timeline.path,
    text: selected_lines.length > 0 ? `${selected_lines.join("\n")}\n` : "",
  };
}

function is_missing_file(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
