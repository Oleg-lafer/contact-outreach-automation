import { domainToASCII } from "node:url";
import { getDomain } from "tldts";
import { ContactInputError } from "./outreach_errors_(Support).js";

export function normalize_outreach_domain(website_url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(website_url);
  } catch {
    throw new ContactInputError("websiteUrl must be a valid URL", website_url);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ContactInputError("websiteUrl must use HTTP or HTTPS", website_url);
  }

  const hostname = domainToASCII(parsed.hostname.toLowerCase()).replace(/\.$/, "");
  if (!hostname) {
    throw new ContactInputError("websiteUrl must contain a hostname", website_url);
  }

  const normalized = getDomain(hostname, { allowPrivateDomains: true });
  return normalized ?? hostname;
}
