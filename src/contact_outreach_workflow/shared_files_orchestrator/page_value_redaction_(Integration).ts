import { randomBytes } from "node:crypto";
import type { Frame, Locator, Page } from "playwright";

interface ContactValueReplacement {
  value: string;
  placeholder: string;
}

export interface PageIntelligenceScope {
  selector: string;
  close: () => Promise<void>;
}

/**
 * Keeps contact values out of Stagehand DOM snapshots. Every accessible frame
 * is sanitized, including hidden controls, serialized value attributes,
 * mirrored text, and attributes outside the selected form. Values are changed
 * without DOM events and restored immediately after the bounded observation.
 */
export async function with_masked_page_values<T>(
  page: Page,
  sensitive_values: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const values = [...new Set(sensitive_values.filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  if (values.length === 0) {
    return operation();
  }

  const token = random_letters(20);
  const replacements = values.map((value, index) => ({
    value,
    placeholder: `[CONTACTWORKFLOWREDACTED${token}${String.fromCharCode(65 + index)}]`,
  }));
  const mask_pattern = values.map(escape_regular_expression).join("|");
  const restore_pattern = replacements
    .map((replacement) => escape_regular_expression(replacement.placeholder))
    .join("|");
  const masked_frames: Frame[] = [];

  try {
    for (const frame of page.frames()) {
      const masked = await mask_frame_contact_values(
        frame,
        replacements,
        mask_pattern,
      );
      if (masked) {
        masked_frames.push(frame);
      }
    }

    return await operation();
  } finally {
    for (const frame of masked_frames) {
      await restore_frame_contact_values(
        frame,
        replacements,
        restore_pattern,
      );
    }
  }
}

/**
 * Adds a temporary selector that limits Stagehand observation to the already
 * selected form. It remains installed through observe/act so returned
 * selectors that reference the scope stay resolvable.
 */
export async function create_page_intelligence_scope(
  root: Locator,
): Promise<PageIntelligenceScope> {
  const attribute = "data-contact-workflow-ai-scope";
  const token = random_letters(24);
  const previous_value = await root.getAttribute(attribute);
  await root.evaluate(
    (element, scope) => element.setAttribute(scope.attribute, scope.token),
    { attribute, token },
  );

  let closed = false;
  return {
    selector: `[${attribute}="${token}"]`,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await root
        .evaluate(
          (element, scope) => {
            if (element.getAttribute(scope.attribute) !== scope.token) {
              return;
            }
            if (scope.previousValue === null) {
              element.removeAttribute(scope.attribute);
            } else {
              element.setAttribute(scope.attribute, scope.previousValue);
            }
          },
          { attribute, token, previousValue: previous_value },
        )
        .catch(() => undefined);
    },
  };
}

async function mask_frame_contact_values(
  frame: Frame,
  replacements: ContactValueReplacement[],
  mask_pattern: string,
): Promise<boolean> {
  return frame.evaluate(({ candidates, patternSource }) => {
      const pattern = new RegExp(patternSource, "g");
      const root = document.documentElement;
      if (!root) {
        return false;
      }

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let text_node = walker.nextNode();
      while (text_node) {
        text_node.nodeValue = (text_node.nodeValue ?? "").replace(
          pattern,
          (match) => {
            for (const candidate of candidates) {
              if (candidate.value === match) {
                return candidate.placeholder;
              }
            }
            return match;
          },
        );
        text_node = walker.nextNode();
      }

      for (const element of Array.from(root.querySelectorAll("*"))) {
        for (const attribute of Array.from(element.attributes)) {
          if (attribute.name === "data-contact-workflow-ai-scope") {
            continue;
          }
          const masked = attribute.value.replace(pattern, (match) => {
            for (const candidate of candidates) {
              if (candidate.value === match) {
                return candidate.placeholder;
              }
            }
            return match;
          });
          if (masked !== attribute.value) {
            element.setAttribute(attribute.name, masked);
          }
        }

        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          element.value = element.value.replace(pattern, (match) => {
            for (const candidate of candidates) {
              if (candidate.value === match) {
                return candidate.placeholder;
              }
            }
            return match;
          });
        }
      }

      return true;
    }, { candidates: replacements, patternSource: mask_pattern });
}

async function restore_frame_contact_values(
  frame: Frame,
  replacements: ContactValueReplacement[],
  restore_pattern: string,
): Promise<void> {
  await frame
    .evaluate(({ candidates, patternSource }) => {
      const pattern = new RegExp(patternSource, "g");
      const root = document.documentElement;
      if (!root) {
        return;
      }

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let text_node = walker.nextNode();
      while (text_node) {
        text_node.nodeValue = (text_node.nodeValue ?? "").replace(
          pattern,
          (match) => {
            for (const candidate of candidates) {
              if (candidate.placeholder === match) {
                return candidate.value;
              }
            }
            return match;
          },
        );
        text_node = walker.nextNode();
      }

      for (const element of Array.from(root.querySelectorAll("*"))) {
        for (const attribute of Array.from(element.attributes)) {
          const restored = attribute.value.replace(pattern, (match) => {
            for (const candidate of candidates) {
              if (candidate.placeholder === match) {
                return candidate.value;
              }
            }
            return match;
          });
          if (restored !== attribute.value) {
            element.setAttribute(attribute.name, restored);
          }
        }

        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          element.value = element.value.replace(pattern, (match) => {
            for (const candidate of candidates) {
              if (candidate.placeholder === match) {
                return candidate.value;
              }
            }
            return match;
          });
        }
      }
    }, { candidates: replacements, patternSource: restore_pattern })
    .catch(() => undefined);
}

function escape_regular_expression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function random_letters(length: number): string {
  return Array.from(randomBytes(length), (value) =>
    String.fromCharCode(65 + (value % 26)),
  ).join("");
}
