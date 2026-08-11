/*
 * ========================================================================
 * SHARED AUTOMATION ERRORS
 * ========================================================================
 * Provides concise, stable error descriptions and the expected input error
 * type used before browser resources are created.
 * ========================================================================
 */

export class ContactInputError extends Error {
  readonly websiteUrl: string;

  constructor(message: string, websiteUrl = "(unknown)") {
    super(message);
    this.name = "ContactInputError";
    this.websiteUrl = websiteUrl;
  }
}

export function describe_error(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/, 1)[0] ?? "Unknown error";
}
