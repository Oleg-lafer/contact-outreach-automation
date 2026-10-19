import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { import_websites, type WebsiteImportRepository } from "./csv_import_service.js";
import { ImportError, MAX_CSV_BYTES, parse_campaign_id } from "./import_contract.js";

function write(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}
async function read_csv(request: IncomingMessage): Promise<Buffer> {
  const length = Number(request.headers["content-length"]);
  if (length > MAX_CSV_BYTES) throw new ImportError(413, "UPLOAD_TOO_LARGE", "The CSV exceeds 5 MiB.");
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep the request alive long enough to return a JSON error for chunked oversized uploads.
  const iterator = request.iterator({ destroyOnReturn: false });
  for await (const chunk of iterator) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_CSV_BYTES) throw new ImportError(413, "UPLOAD_TOO_LARGE", "The CSV exceeds 5 MiB.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function create_import_server(repository: WebsiteImportRepository, token: string) {
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
      const match = /^\/internal\/contact-us\/campaigns\/([^/?]+)\/websites\/import$/.exec(request.url ?? "");
      if (!match) throw new ImportError(404, "NOT_FOUND", "The route does not exist.");
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        throw new ImportError(405, "METHOD_NOT_ALLOWED", "Use POST.");
      }
      const campaignId = parse_campaign_id(match[1]!);
      const contentType = request.headers["content-type"] ?? "";
      if (!/^text\/csv(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
        throw new ImportError(415, "UNSUPPORTED_MEDIA_TYPE", "Use text/csv with UTF-8.");
      }
      const result = await import_websites(campaignId, await read_csv(request), repository);
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
