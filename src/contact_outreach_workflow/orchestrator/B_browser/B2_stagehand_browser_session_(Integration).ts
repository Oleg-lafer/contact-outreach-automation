import { createServer } from "node:net";
import type { PageIntelligence } from "../../shared_files_orchestrator/page_intelligence_(Integration).js";
import {
  create_stagehand_runtime,
  type StagehandConfiguration,
  type StagehandRuntime,
} from "../../shared_files_orchestrator/stagehand_client_(LLM).js";

/*
 * ========================================================================
 * LOCAL STAGEHAND BROWSER SESSION
 * ========================================================================
 * Playwright owns the local Chromium process. Stagehand attaches lazily over
 * CDP to the same browser/page only when a deterministic stage needs AI.
 * ========================================================================
 */

export interface LazyStagehandAttachmentOptions {
  cdpUrl: string | (() => Promise<string>);
  configuration?: StagehandConfiguration;
  environment?: NodeJS.ProcessEnv;
}

export interface LazyStagehandAttachment {
  current: () => PageIntelligence | undefined;
  ensure: () => Promise<PageIntelligence>;
  close: () => Promise<void>;
}

export function create_lazy_stagehand_attachment(
  options: LazyStagehandAttachmentOptions,
): LazyStagehandAttachment {
  let runtime: StagehandRuntime | undefined;
  let runtime_promise: Promise<StagehandRuntime> | undefined;

  const ensure_runtime = async (): Promise<StagehandRuntime> => {
    if (runtime) {
      return runtime;
    }
    runtime_promise ??= (async () =>
      create_stagehand_runtime({
        cdpUrl:
          typeof options.cdpUrl === "string"
            ? options.cdpUrl
            : await options.cdpUrl(),
        ...(options.configuration
          ? { configuration: options.configuration }
          : {}),
        ...(options.environment ? { environment: options.environment } : {}),
      }))();
    try {
      runtime = await runtime_promise;
      return runtime;
    } catch (error) {
      runtime_promise = undefined;
      throw error;
    }
  };

  return {
    current: () => runtime?.pageIntelligence,
    ensure: async () => (await ensure_runtime()).pageIntelligence,
    close: async () => {
      const initialized_runtime = runtime ?? (await runtime_promise?.catch(() => undefined));
      runtime = undefined;
      runtime_promise = undefined;
      await initialized_runtime?.close().catch(() => undefined);
    },
  };
}

export async function reserve_loopback_cdp_port(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (port <= 0) {
          reject(new Error("Could not reserve a loopback CDP port."));
        } else {
          resolve(port);
        }
      });
    });
  });
}

export async function wait_for_cdp_websocket_url(
  port: number,
  timeout_ms: number,
): Promise<string> {
  const deadline = Date.now() + timeout_ms;
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  let last_error: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const payload = (await response.json()) as {
          webSocketDebuggerUrl?: unknown;
        };
        if (typeof payload.webSocketDebuggerUrl === "string") {
          return payload.webSocketDebuggerUrl;
        }
      }
    } catch (error) {
      last_error = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const detail = last_error instanceof Error ? `: ${last_error.message}` : "";
  throw new Error(`Could not connect to the Playwright CDP endpoint${detail}`);
}
