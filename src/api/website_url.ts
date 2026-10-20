import { isIP } from "node:net";

/** Check syntax only. This never visits a website or resolves its hostname. */
export function valid_website_url(value: string): boolean {
  try {
    const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1];
    if (!authority || authority.includes("@") || /[\s\u0000-\u001f\u007f]/u.test(value) || value.includes("\\")) return false;
    const url = new URL(value);
    if (!url.hostname || url.username || url.password || !["http:", "https:"].includes(url.protocol)) return false;
    const hostname = url.hostname.replace(/\.$/, "");
    return hostname.length <= 253 && (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0 ||
      hostname.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)));
  } catch { return false; }
}
