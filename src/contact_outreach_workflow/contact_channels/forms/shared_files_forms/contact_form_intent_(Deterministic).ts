import type { Locator } from "playwright";
import type {
  ContactFormClassification,
  ContactFormAssessmentSignals,
  MessageDisposition,
} from "./forms_types_(Support).js";
import { CAPTCHA_SELECTOR } from "./captcha_detection_(Deterministic).js";
import {
  form_semantic_sources,
  type FormSemanticKey,
} from "./form_semantics_(Deterministic).js";

export interface ContactFormAssessment {
  accepted: boolean;
  classification: ContactFormClassification | "rejected";
  score: number;
  reason: string;
  messageDisposition: Exclude<MessageDisposition, "populated">;
  signals: ContactFormAssessmentSignals;
  diagnostics?: {
    tagName: string;
    domPath: string;
    action: string;
    method: string;
    contextExcerpt: string;
    controls: Array<{
      tagName: string;
      type: string;
      name: string;
      label: string;
      placeholder: string;
      required: boolean;
      disabled: boolean;
      readOnly: boolean;
      visible: boolean;
      width: number;
      height: number;
    }>;
    ruleId: string;
    scoreContributions: Array<{ ruleId: string; score: number }>;
    omittedControls: number;
  };
}

export async function assess_contact_form(
  locator: Locator,
): Promise<ContactFormAssessment> {
  return locator
    .evaluate<ContactFormAssessment, {
      captchaSelector: string;
      semanticSources: Record<FormSemanticKey, string>;
    }>((element, input) => {
      const captcha_selector = input.captchaSelector;
      const semantic = Object.fromEntries(
        Object.entries(input.semanticSources).map(([key, source]) => [
          key,
          new RegExp(source, "iu"),
        ]),
      ) as Record<FormSemanticKey, RegExp>;
      const controls = Array.from(
        element.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select, [contenteditable="true"]',
        ),
      ).filter((candidate) => {
        const html_element = candidate as HTMLElement;
        const style = window.getComputedStyle(html_element);
        const rectangle = html_element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rectangle.width > 0 &&
          rectangle.height > 0
        );
      });
      const submit_controls = Array.from(
        element.querySelectorAll(
          'button, input[type="submit"], input[type="button"], [role="button"], a[href]',
        ),
      ).filter((candidate) => {
        const html_element = candidate as HTMLElement;
        const style = window.getComputedStyle(html_element);
        const rectangle = html_element.getBoundingClientRect();
        const tag = candidate.tagName.toLowerCase();
        const semantics = [
          candidate.textContent,
          candidate.id,
          candidate.getAttribute("class"),
          candidate.getAttribute("aria-label"),
        ]
          .filter(Boolean)
          .join(" ");
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rectangle.width > 0 &&
          rectangle.height > 0 &&
          (tag !== "a" ||
            candidate.getAttribute("role") === "button" ||
            semantic.submit.test(semantics.normalize("NFKC")
              .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
              .replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, "")
              .toLowerCase()))
        );
      });
      const control_metadata = controls
        .map((control) => {
          const labels =
            "labels" in control
              ? Array.from(
                  (control as HTMLInputElement | HTMLTextAreaElement).labels ?? [],
                ).map((label) => label.textContent ?? "")
              : [];
          return [
            control.getAttribute("name"),
            control.id,
            control.getAttribute("type"),
            control.getAttribute("placeholder"),
            control.getAttribute("aria-label"),
            ...labels,
          ]
            .filter(Boolean)
            .join(" ")
            .normalize("NFKC")
            .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
            .replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, "")
            .toLowerCase();
        })
        .join(" ");
      const submit_metadata = submit_controls
        .map((control) =>
          [
            control.textContent,
            control.getAttribute("value"),
            control.getAttribute("aria-label"),
            control.id,
          ]
            .filter(Boolean)
            .join(" "),
        )
        .join(" ")
        .normalize("NFKC")
        .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
        .replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, "")
        .toLowerCase();
      const has_safe_progression = submit_controls.some((control) => {
        if (control.matches(captcha_selector) || control.closest(captcha_selector)) {
          return false;
        }
        const tag = control.tagName.toLowerCase();
        const type = control.getAttribute("type")?.toLowerCase() ?? "";
        const label = [
          control.textContent,
          control.getAttribute("value"),
          control.getAttribute("aria-label"),
          control.getAttribute("title"),
        ]
          .filter(Boolean)
          .join(" ")
          .trim()
          .replace(/\s+/g, " ");
        const exact_progression_label = new RegExp(
          `^(?:${semantic.progression.source})(?:\\s*(?:→|>|»))?$`,
          "iu",
        ).test(label.normalize("NFKC")
          .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
          .replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, "")
          .toLowerCase());
        const explicit_non_submit =
          (tag === "button" && type === "button") ||
          (tag === "input" && type === "button") ||
          (tag !== "button" &&
            tag !== "input" &&
            control.getAttribute("role") === "button" &&
            !control.getAttribute("href"));
        return (
          exact_progression_label &&
          explicit_non_submit
        );
      });
      const has_direct_submit = submit_controls.some((control) => {
        const tag = control.tagName.toLowerCase();
        const type = control.getAttribute("type")?.toLowerCase() ?? "";
        const label = [
          control.textContent,
          control.getAttribute("value"),
          control.getAttribute("aria-label"),
          control.getAttribute("title"),
        ]
          .filter(Boolean)
          .join(" ")
          .trim();
        return (
          ["submit", "image"].includes(type) ||
          semantic.submit.test(label.normalize("NFKC")
            .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
            .replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, "")
            .toLowerCase())
        ) && !new RegExp(`^(?:${semantic.progression.source})$`, "iu")
          .test(label.normalize("NFKC")
            .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
            .replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, "")
            .toLowerCase());
      });
      const context_container =
        element.closest("section, article, main") ?? element.parentElement;
      const context = [
        element.getAttribute("name"),
        element.id,
        element.getAttribute("aria-label"),
        element.textContent,
        context_container?.querySelector("h1, h2, h3")?.textContent,
        document.title,
        window.location.pathname,
        control_metadata,
        submit_metadata,
      ]
        .filter(Boolean)
        .join(" ")
        .normalize("NFKC")
        .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
        .replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, "")
        .toLowerCase();
      const has_message =
        controls.some(
          (control) =>
            control.tagName.toLowerCase() === "textarea" ||
            control.getAttribute("contenteditable") === "true",
        ) || semantic.message.test(control_metadata.normalize("NFKC"));
      const has_email =
        controls.some(
          (control) => control.getAttribute("type")?.toLowerCase() === "email",
        ) || semantic.email.test(control_metadata.normalize("NFKC"));
      const normalized_control_metadata = control_metadata.normalize("NFKC");
      const has_phone = controls.some(
        (control) => control.getAttribute("type")?.toLowerCase() === "tel",
      ) || semantic.phone.test(normalized_control_metadata);
      const has_identity = semantic.firstName.test(normalized_control_metadata) ||
        semantic.lastName.test(normalized_control_metadata) ||
        semantic.fullName.test(normalized_control_metadata) ||
        semantic.phone.test(normalized_control_metadata) ||
        semantic.company.test(normalized_control_metadata) ||
        semantic.website.test(normalized_control_metadata);
      const business_text = `${control_metadata} ${element.textContent ?? ""}`
        .normalize("NFKC").toLowerCase();
      const has_business_or_project = semantic.company.test(business_text) ||
        /project|service|budget|challenge|goal|פרויקט|שירות|תקציב|אתגר|מטרה/u.test(business_text);
      const has_submit = submit_controls.length > 0;
      const normalized_context = context.normalize("NFKC").toLowerCase();
      const has_contact_context = semantic.contact.test(normalized_context);
      const has_search_or_login_context =
        semantic.login.test(normalized_context) ||
        (semantic.search.test(normalized_context) &&
          !has_message && !has_contact_context);
      const has_route_context =
        semantic.directions.test(normalized_context) && !has_message;
      const has_newsletter_context =
        semantic.newsletter.test(normalized_context) &&
          !has_message &&
          !has_business_or_project;
      const has_job_context =
        semantic.jobs.test(normalized_context);
      const has_negative_context =
        has_search_or_login_context ||
        has_route_context ||
        has_newsletter_context ||
        has_job_context;

      let score = 0;
      if (has_contact_context) score += 4;
      if (has_message) score += 6;
      if (has_email) score += 5;
      if (has_identity) score += 2;
      if (has_business_or_project) score += 2;
      if (has_submit) score += 2;
      if (has_safe_progression) score += 3;
      if (has_negative_context) score -= 12;

      const complete =
        !has_negative_context &&
        has_submit &&
        has_message &&
        (has_email || has_phone || has_contact_context || controls.length === 1);
      const progression =
        !complete &&
        !has_negative_context &&
        has_safe_progression &&
        has_contact_context &&
        (has_email || has_identity || has_business_or_project);
      const accepted = complete || progression;
      const classification: ContactFormClassification | "rejected" = complete
        ? "complete"
        : progression
          ? "progression"
          : "rejected";
      const signals: ContactFormAssessmentSignals = {
        visibleControlCount: controls.length,
        hasMessage: has_message,
        hasEmail: has_email,
        hasPhone: has_phone,
        hasIdentity: has_identity,
        hasBusinessOrProject: has_business_or_project,
        hasSubmit: has_submit,
        hasSafeProgression: has_safe_progression,
        hasContactContext: has_contact_context,
        hasNegativeContext: has_negative_context,
      };
      let reason = complete
        ? "accepted as a complete contact form"
        : "accepted as a bounded multi-step contact form";
      if (!accepted) {
        if (has_newsletter_context)
          reason = "form has newsletter or subscription semantics";
        else if (has_route_context)
          reason = "form has route/directions semantics";
        else if (has_search_or_login_context)
          reason = "form has search or login semantics";
        else if (has_job_context)
          reason = "form has job-application semantics";
        else if (!has_submit) reason = "form has no visible submit control";
        else if (!has_email) reason = "form has no visible email control";
        else if (!has_message && !has_contact_context)
          reason = "form has neither a message field nor strong contact-page context";
        else if (!has_message && !has_safe_progression)
          reason =
            "form offers no message field and no safe non-submit progression control";
        else reason = "form does not have a sufficient contact shape";
      }
      const rule_id = complete
        ? "DISCOVERY-CANDIDATE-COMPLETE"
        : progression
          ? "DISCOVERY-CANDIDATE-PROGRESSION"
          : has_newsletter_context
            ? "DISCOVERY-REJECT-NEWSLETTER"
            : has_route_context
              ? "DISCOVERY-REJECT-DIRECTIONS"
              : has_search_or_login_context
                ? "DISCOVERY-REJECT-SEARCH-LOGIN"
                : has_job_context
                  ? "DISCOVERY-REJECT-JOBS"
                  : !has_submit
                    ? "DISCOVERY-REJECT-NO-SUBMIT"
                    : !has_email
                      ? "DISCOVERY-REJECT-NO-EMAIL"
                      : !has_message && !has_contact_context
                        ? "DISCOVERY-REJECT-NO-MESSAGE-CONTEXT"
                        : !has_message && !has_safe_progression
                          ? "DISCOVERY-REJECT-NO-MESSAGE-PROGRESSION"
                          : "DISCOVERY-REJECT-SHAPE";
      const score_contributions = [
        ...(has_contact_context ? [{ ruleId: "SCORE-CONTACT-CONTEXT", score: 4 }] : []),
        ...(has_message ? [{ ruleId: "SCORE-MESSAGE", score: 6 }] : []),
        ...(has_email ? [{ ruleId: "SCORE-EMAIL", score: 5 }] : []),
        ...(has_identity ? [{ ruleId: "SCORE-IDENTITY", score: 2 }] : []),
        ...(has_business_or_project ? [{ ruleId: "SCORE-BUSINESS-PROJECT", score: 2 }] : []),
        ...(has_submit ? [{ ruleId: "SCORE-SUBMIT", score: 2 }] : []),
        ...(has_safe_progression ? [{ ruleId: "SCORE-SAFE-PROGRESSION", score: 3 }] : []),
        ...(has_negative_context ? [{ ruleId: "SCORE-NEGATIVE-CONTEXT", score: -12 }] : []),
      ];
      const dom_indexes: number[] = [];
      let current: Element | null = element;
      while (current?.parentElement) {
        dom_indexes.unshift(Array.prototype.indexOf.call(current.parentElement.children, current));
        current = current.parentElement;
      }
      const diagnostic_controls = [...controls, ...submit_controls]
        .slice(0, 20)
        .map((control) => {
          const bounds = (control as HTMLElement).getBoundingClientRect();
          const style = window.getComputedStyle(control as HTMLElement);
          const labels = "labels" in control
            ? Array.from((control as HTMLInputElement | HTMLTextAreaElement).labels ?? [])
                .map((label) => label.textContent ?? "")
                .join(" ")
            : "";
          return {
            tagName: control.tagName.toLowerCase(),
            type: control.getAttribute("type") ?? "",
            name: control.getAttribute("name") ?? "",
            label: [labels, control.textContent, control.getAttribute("aria-label")]
              .filter(Boolean).join(" ").trim().replace(/\s+/g, " ").slice(0, 200).replace(/[\uD800-\uDBFF]$/, ""),
            placeholder: (control.getAttribute("placeholder") ?? "").slice(0, 200).replace(/[\uD800-\uDBFF]$/, ""),
            required: control.hasAttribute("required") || control.getAttribute("aria-required") === "true",
            disabled: control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true",
            readOnly: control.hasAttribute("readonly"),
            visible: style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0,
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
          };
        });
      return {
        accepted,
        classification,
        score,
        reason,
        messageDisposition: has_message ? "unresolved" : "notOffered",
        signals,
        diagnostics: {
          tagName: element.tagName.toLowerCase(),
          domPath: dom_indexes.join("/"),
          action: element.getAttribute("action") ?? "",
          method: element.getAttribute("method") ?? "",
          contextExcerpt: context.trim().replace(/\s+/g, " ").slice(0, 500).replace(/[\uD800-\uDBFF]$/, ""),
          controls: diagnostic_controls,
          ruleId: rule_id,
          scoreContributions: score_contributions,
          omittedControls: Math.max(0, controls.length + submit_controls.length - diagnostic_controls.length),
        },
      };
    }, {
      captchaSelector: CAPTCHA_SELECTOR,
      semanticSources: form_semantic_sources(),
    })
    .catch((error: unknown) => ({
      accepted: false,
      classification: "rejected" as const,
      score: -100,
      reason: `form candidate could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      messageDisposition: "unresolved" as const,
      signals: {
        visibleControlCount: 0,
        hasMessage: false,
        hasEmail: false,
        hasPhone: false,
        hasIdentity: false,
        hasBusinessOrProject: false,
        hasSubmit: false,
        hasSafeProgression: false,
        hasContactContext: false,
        hasNegativeContext: false,
      },
    }));
}
