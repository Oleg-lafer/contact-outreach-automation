import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { import_websites, type WebsiteImportRepository } from "./csv_import_service.js";
import { ImportError, MAX_CSV_BYTES, parse_campaign_id } from "./import_contract.js";
import { createCampaign, parseCampaignJson, MAX_CAMPAIGN_BYTES, type CampaignRepository } from "./campaign_service.js";

import { launchCampaign, parseLaunchJson, MAX_LAUNCH_BYTES, type LaunchRepository } from "./launch_service.js";

function write(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}
async function read_body(request: IncomingMessage, maxBytes: number, code: string, message: string): Promise<Buffer> {
  const length = Number(request.headers["content-length"]);
  if (length > maxBytes) throw new ImportError(413, code, message);
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep the request alive long enough to return a JSON error for chunked oversized uploads.
  const iterator = request.iterator({ destroyOnReturn: false });
  for await (const chunk of iterator) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new ImportError(413, code, message);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function create_import_server(repository: WebsiteImportRepository, token: string,
  campaignRepository?: CampaignRepository, launchRepository?: LaunchRepository) {
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error("CONTACT_US_SERVICE_TOKEN must be a non-empty ASCII token without whitespace.");
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (request, response) => {
    try {
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw new ImportError(401, "UNAUTHORIZED", "A valid service token is required.");
      }
      const isCreate = request.url === "/internal/contact-us/campaigns";
      const match = /^\/internal\/contact-us\/campaigns\/([^/?]+)\/websites\/import$/.exec(request.url ?? "");
      const launchMatch = /^\/internal\/contact-us\/campaigns\/([^/?]+)\/runs$/.exec(request.url ?? "");
      if (!isCreate && !match && !launchMatch) throw new ImportError(404, "NOT_FOUND", "The route does not exist.");
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        throw new ImportError(405, "METHOD_NOT_ALLOWED", "Use POST.");
      }
      const contentType = request.headers["content-type"] ?? "";
      if (launchMatch) {
        if (request.headers["content-encoding"] && request.headers["content-encoding"].toLowerCase() !== "identity") {
          throw new ImportError(415, "UNSUPPORTED_MEDIA_TYPE", "Send uncompressed UTF-8 JSON.");
        }
        const campaignId = parse_campaign_id(launchMatch[1]!);
        if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
          throw new ImportError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json with UTF-8.");
        }
        const bytes = await read_body(request, MAX_LAUNCH_BYTES, "REQUEST_TOO_LARGE", "The launch request exceeds 4 KiB.");
        const input = parseLaunchJson(bytes);
        if (!launchRepository) throw new ImportError(503, "SERVICE_UNAVAILABLE", "The launch service is unavailable.");
        write(response, 202, await launchCampaign(campaignId, input, launchRepository));
        return;
      }
      if (isCreate) {
        if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
          throw new ImportError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json with UTF-8.");
        }
        if (!campaignRepository) throw new ImportError(500, "INTERNAL_ERROR", "Campaign creation is unavailable.");
        const bytes = await read_body(request, MAX_CAMPAIGN_BYTES, "REQUEST_TOO_LARGE", "The JSON request exceeds 256 KiB.");
        write(response, 201, await createCampaign(parseCampaignJson(bytes), campaignRepository));
        return;
      }
      const campaignId = parse_campaign_id(match![1]!);
      if (!/^text\/csv(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
        throw new ImportError(415, "UNSUPPORTED_MEDIA_TYPE", "Use text/csv with UTF-8.");
      }
      const result = await import_websites(campaignId,
        await read_body(request, MAX_CSV_BYTES, "UPLOAD_TOO_LARGE", "The CSV exceeds 5 MiB."), repository);
      write(response, 200, result);
    } catch (error) {
      const failure = error instanceof ImportError ? error :
        new ImportError(500, "INTERNAL_ERROR", "The import could not be completed.");
      // Drain discarded input without buffering it. Closing during a client upload
      // can reset the socket before the client receives the JSON error.
      request.resume();
      if (!response.destroyed) write(response, failure.status, failure.toJSON());
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
