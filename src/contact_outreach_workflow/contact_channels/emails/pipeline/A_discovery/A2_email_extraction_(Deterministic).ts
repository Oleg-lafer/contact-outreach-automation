import type { Frame, Page } from "playwright";

const EMAIL_PATTERN =
  /(?<![A-Z0-9.!#$%&'*+/=?^_`{|}~-])[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+(?![A-Z0-9_-])/gi;

export async function extract_usable_emails_from_page(
  page: Page,
  options: {
    senderEmail: string;
    targetOrigin: string;
  },
): Promise<string[]> {
  const discovered = new Set<string>();

  for (const frame of page.frames()) {
    if (!is_inspectable_frame(frame, options.targetOrigin)) {
      continue;
    }

    const visible_text = await frame
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => "");
    for (const email of extract_literal_emails(visible_text)) {
      discovered.add(email);
    }

    const mailto_links = await collect_visible_mailto_links(frame);
    for (const href of mailto_links) {
      for (const email of extract_mailto_recipient_emails(href)) {
        discovered.add(email);
      }
    }
  }

  const sender_email = options.senderEmail.trim().toLowerCase();
  return [...discovered]
    .filter(
      (email) =>
        email !== sender_email && !is_non_reply_address(email),
    )
    .sort((left, right) => left.localeCompare(right));
}

export function extract_literal_emails(value: string): string[] {
  const emails = new Set<string>();
  for (const match of value.matchAll(EMAIL_PATTERN)) {
    const candidate = normalize_email_candidate(match[0]);
    if (candidate) {
      emails.add(candidate);
    }
  }
  return [...emails].sort((left, right) => left.localeCompare(right));
}

export function extract_mailto_recipient_emails(href: string): string[] {
  if (!href.toLowerCase().startsWith("mailto:")) {
    return [];
  }

  const recipient_path = href.slice("mailto:".length).split("?", 1)[0] ?? "";
  const decoded_path = decode_mailto_path(recipient_path);
  const emails = new Set<string>();
  for (const recipient of decoded_path.split(/[;,]/)) {
    for (const email of extract_literal_emails(recipient)) {
      emails.add(email);
    }
  }
  return [...emails].sort((left, right) => left.localeCompare(right));
}

function normalize_email_candidate(value: string): string | undefined {
  const email = value.toLowerCase();
  if (email.length > 254) {
    return undefined;
  }
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) {
    return undefined;
  }

  const local_part = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  if (
    local_part.length > 64 ||
    local_part.startsWith(".") ||
    local_part.endsWith(".") ||
    local_part.includes("..")
  ) {
    return undefined;
  }

  const labels = domain.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    return undefined;
  }

  const top_level_domain = labels.at(-1) ?? "";
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(top_level_domain)) {
    return undefined;
  }
  return email;
}

function is_non_reply_address(email: string): boolean {
  const local_part = email.slice(0, email.lastIndexOf("@"));
  return /^(?:no[._-]?reply|do[._-]?not[._-]?reply)$/.test(local_part);
}

function is_inspectable_frame(frame: Frame, target_origin: string): boolean {
  const frame_url = frame.url();
  if (!frame_url || frame_url === "about:blank") {
    return true;
  }
  try {
    return new URL(frame_url).origin === target_origin;
  } catch {
    return false;
  }
}

async function collect_visible_mailto_links(frame: Frame): Promise<string[]> {
  return frame
    .locator("a[href]")
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const href = element.getAttribute("href") ?? "";
          if (!href.toLowerCase().startsWith("mailto:")) {
            return false;
          }

          let current: Element | null = element;
          while (current) {
            if (
              current.hasAttribute("hidden") ||
              current.getAttribute("aria-hidden") === "true"
            ) {
              return false;
            }
            const style = window.getComputedStyle(current);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.visibility === "collapse" ||
              style.opacity === "0"
            ) {
              return false;
            }
            current = current.parentElement;
          }
          return element.getClientRects().length > 0;
        })
        .map((element) => element.getAttribute("href") ?? ""),
    )
    .catch(() => []);
}

function decode_mailto_path(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", "%20"));
  } catch {
    return value;
  }
}
