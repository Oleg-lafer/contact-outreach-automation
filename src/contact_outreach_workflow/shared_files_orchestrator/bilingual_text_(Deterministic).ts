const BIDI_FORMATTING_MARKS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const HEBREW_DIACRITICS = /[\u0591-\u05bd\u05bf-\u05c7]/g;

/**
 * Normalizes English/Hebrew interface text without changing the original
 * evidence retained by callers. The always-on bilingual workflow deliberately
 * has no runtime language branch.
 */
export function normalize_bilingual_text(value: string): string {
  return value
    .normalize("NFKC")
    .replace(BIDI_FORMATTING_MARKS, "")
    .replace(HEBREW_DIACRITICS, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function safely_decode_url_text(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
