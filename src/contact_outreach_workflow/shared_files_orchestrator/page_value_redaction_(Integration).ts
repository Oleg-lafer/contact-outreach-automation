import { randomBytes } from "node:crypto";
import type { Locator } from "playwright";

export interface PageIntelligenceScope {
  selector: string;
  close: () => Promise<void>;
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

function random_letters(length: number): string {
  return Array.from(randomBytes(length), (value) =>
    String.fromCharCode(65 + (value % 26)),
  ).join("");
}
