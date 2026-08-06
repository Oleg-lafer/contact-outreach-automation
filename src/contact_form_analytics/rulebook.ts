import type {
  Attribution,
  CauseFamily,
  EvidenceTier,
  RuleDefinition,
  SiteClassification,
  SiteEvidence,
  StageState,
  TerminalStage,
} from "./analytics_types.js";
import { RULEBOOK_VERSION, STAGES } from "./analytics_types.js";

interface Decision {
  ruleId: string;
  runState: SiteClassification["runState"];
  terminalStage: TerminalStage;
  attribution: Attribution;
  causeFamily: CauseFamily;
  subcategory: string;
  evidenceBasis: EvidenceTier;
  evidenceSummary: string;
  primaryCause: string;
  secondarySignals?: string[];
}

interface OrderedRule extends RuleDefinition {
  matches: (site: SiteEvidence) => boolean;
  decide?: (site: SiteEvidence) => Partial<Decision>;
}

const text = (site: SiteEvidence): string =>
  [site.reason, site.description, site.failureKind, ...site.structuredEvidence, ...site.debugEvidence, site.fullText]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

const primaryText = (site: SiteEvidence): string =>
  [site.reason, site.description, site.failureKind, site.fullText].filter(Boolean).join("\n").toLowerCase();

const has = (site: SiteEvidence, pattern: RegExp): boolean => pattern.test(text(site));
const statusIs = (site: SiteEvidence, value: string): boolean => site.status.toLowerCase() === value;
const assessmentIs = (site: SiteEvidence, value: string): boolean => site.discoveryAssessment === value;
const isBrowserTerminal = (site: SiteEvidence): boolean =>
  site.failureKind === "navigation.failed" || assessmentIs(site, "site_inspection_blocked");
const isDiscoveryTerminal = (site: SiteEvidence): boolean =>
  site.mode === "discovery" ||
  site.failureKind.startsWith("discovery.") ||
  (site.discoveryAssessment !== "" && !assessmentIs(site, "confirmed_form_present") && !assessmentIs(site, "site_inspection_blocked"));

const baseRules: Array<Omit<OrderedRule, "order">> = [
  {
    id: "DAT-CONFLICTING-STRUCTURED-EVIDENCE",
    stage: "reporting",
    title: "Conflicting structured evidence",
    attribution: "indeterminate",
    causeFamily: "conflicting_evidence",
    subcategory: "conflicting_structured_evidence",
    evidenceTier: "structured_json",
    description: "Structured primary artifacts disagree about mode, status, or discovery assessment.",
    matches: (site) => site.conflictingModeEvidence || site.conflictingStructuredEvidence,
  },
  {
    id: "INP-MALFORMED-OR-MISSING",
    stage: "input",
    title: "Malformed or missing input",
    attribution: "workflow_attributable",
    causeFamily: "input_data_issue",
    subcategory: "malformed_or_missing_input",
    evidenceTier: "structured_json",
    description: "Input JSON is explicitly missing or malformed.",
    matches: (site) =>
      site.failureKind === "input.invalid" && has(site, /malform|missing input|could not read|parse|json|input file/),
  },
  {
    id: "INP-INVALID-URL",
    stage: "input",
    title: "Invalid website URL",
    attribution: "workflow_attributable",
    causeFamily: "input_data_issue",
    subcategory: "invalid_website_url",
    evidenceTier: "structured_text",
    description: "The supplied website URL is missing, malformed, or not HTTP(S).",
    matches: (site) => site.failureKind === "input.invalid" && has(site, /url|website|http/),
  },
  {
    id: "INP-MISSING-GREETING-OR-TEMPLATE",
    stage: "input",
    title: "Missing greeting or invalid template",
    attribution: "workflow_attributable",
    causeFamily: "input_data_issue",
    subcategory: "missing_greeting_or_template_data",
    evidenceTier: "structured_text",
    description: "Greeting or message-template data required by the run is missing or invalid.",
    matches: (site) =>
      (site.failureKind === "input.invalid" || site.failureKind === "") &&
      /greeting_name|greeting name|message template|template (?:is )?(?:missing|invalid)/.test(primaryText(site)),
  },
  {
    id: "INP-INVALID-CONTACT-VALUES",
    stage: "input",
    title: "Missing or invalid contact values",
    attribution: "workflow_attributable",
    causeFamily: "input_data_issue",
    subcategory: "missing_or_invalid_contact_values",
    evidenceTier: "structured_text",
    description: "A supplied name, email, phone, message, or other required contact value is explicitly invalid.",
    matches: (site) =>
      site.failureKind === "input.invalid" ||
      /(?:missing|invalid|empty) (?:contact value|email value|phone value|message value|name value)/.test(primaryText(site)),
  },
  {
    id: "BRW-RESEND-PREVENTED",
    stage: "browser",
    title: "Outreach resend prevented before browser execution",
    attribution: "non_workflow_attributable",
    causeFamily: "policy_scope_boundary",
    subcategory: "outreach_resend_prevented",
    evidenceTier: "structured_text",
    description: "The campaign safety check prevented duplicate outreach before browser execution.",
    matches: (site) => site.failureKind === "outreach.resend_prevented",
  },
  {
    id: "ENV-EXPLICIT-RUN-INTERRUPTION",
    stage: "reporting",
    title: "Explicit local execution interruption",
    attribution: "workflow_attributable",
    causeFamily: "execution_environment_issue",
    subcategory: "run_interrupted_by_local_environment",
    evidenceTier: "structured_text",
    description: "An artifact explicitly records system sleep/restart, process termination, resource exhaustion, disk, permission, dependency, or API configuration failure.",
    matches: (site) =>
      /system (?:sleep|restart)|windows (?:sleep|restart)|process (?:terminated|killed)|out of memory|resource exhaustion|disk (?:full|space)|permission denied|eacces|missing (?:dependency|browser installation|api key)|api configuration/.test(
        primaryText(site),
      ),
  },
  {
    id: "BRW-DNS-FAILURE",
    stage: "browser",
    title: "DNS resolution failure",
    attribution: "non_workflow_attributable",
    causeFamily: "external_site_or_service_issue",
    subcategory: "dns_resolution_failure",
    evidenceTier: "structured_text",
    description: "The target hostname could not be resolved.",
    matches: (site) => isBrowserTerminal(site) && has(site, /err_name_not_resolved|dns (?:failure|resolution)/),
  },
  {
    id: "BRW-CONNECTION-FAILURE",
    stage: "browser",
    title: "Connection refused or reset",
    attribution: "non_workflow_attributable",
    causeFamily: "external_site_or_service_issue",
    subcategory: "connection_refused_or_reset",
    evidenceTier: "structured_text",
    description: "The remote site refused or reset the connection.",
    matches: (site) =>
      isBrowserTerminal(site) && has(site, /err_connection_(?:refused|reset|closed|aborted)|connection (?:refused|reset)/),
  },
  {
    id: "BRW-TLS-FAILURE",
    stage: "browser",
    title: "TLS or certificate failure",
    attribution: "non_workflow_attributable",
    causeFamily: "external_site_or_service_issue",
    subcategory: "tls_or_certificate_failure",
    evidenceTier: "structured_text",
    description: "The target site could not be inspected because of a TLS or certificate error.",
    matches: (site) =>
      isBrowserTerminal(site) &&
      has(site, /err_cert_|tls (?:failure|error)|ssl (?:failure|error)|certificate (?:invalid|error|expired)/),
  },
  {
    id: "BRW-ACCESS-DENIED-OR-ANTIBOT",
    stage: "browser",
    title: "Access denied or sitewide anti-bot challenge",
    attribution: "non_workflow_attributable",
    causeFamily: "external_site_or_service_issue",
    subcategory: "access_denied_or_sitewide_antibot",
    evidenceTier: "structured_text",
    description: "The starting site was blocked by access controls or a sitewide challenge.",
    matches: (site) =>
      isBrowserTerminal(site) &&
      has(site, /access denied|forbidden|http 403|status 403|cloudflare|sitewide.*(?:captcha|challenge)|browser challenge/),
  },
  {
    id: "BRW-SITE-UNAVAILABLE",
    stage: "browser",
    title: "Site unavailable",
    attribution: "non_workflow_attributable",
    causeFamily: "external_site_or_service_issue",
    subcategory: "site_unavailable",
    evidenceTier: "structured_text",
    description: "The starting site was explicitly unavailable or returned a server outage response.",
    matches: (site) =>
      isBrowserTerminal(site) &&
      has(site, /site unavailable|service unavailable|bad gateway|gateway timeout|http 5\d\d|status 5\d\d/),
  },
  {
    id: "BRW-REDIRECT-LOOP",
    stage: "browser",
    title: "Redirect loop",
    attribution: "non_workflow_attributable",
    causeFamily: "external_site_or_service_issue",
    subcategory: "redirect_loop",
    evidenceTier: "structured_text",
    description: "The target site entered a redirect loop.",
    matches: (site) => isBrowserTerminal(site) && has(site, /err_too_many_redirects|redirect loop|too many redirects/),
  },
  {
    id: "BRW-WORKFLOW-STARTUP-FAILURE",
    stage: "browser",
    title: "Browser startup or integration failure",
    attribution: "workflow_attributable",
    causeFamily: "execution_environment_issue",
    subcategory: "browser_launch_context_or_cdp_failure",
    evidenceTier: "structured_text",
    description: "Browser launch, context creation, CDP attachment, runtime configuration, or dependency setup failed.",
    matches: (site) =>
      isBrowserTerminal(site) &&
      has(site, /browser (?:launch|executable|installation)|failed to launch|context creation|cdp (?:attach|connection)|failed to attach stagehand|stagehand (?:cdp )?attachment failed|missing dependency|configuration (?:failure|error)/),
  },
  {
    id: "BRW-NAVIGATION-TIMEOUT",
    stage: "browser",
    title: "Navigation timeout",
    attribution: "indeterminate",
    causeFamily: "insufficient_evidence",
    subcategory: "navigation_timeout",
    evidenceTier: "structured_text",
    description: "Navigation timed out without evidence that safely assigns responsibility.",
    matches: (site) =>
      isBrowserTerminal(site) && has(site, /timeout|timed out/),
  },
  {
    id: "BRW-PAGE-CRASH-OR-DETACHMENT",
    stage: "browser",
    title: "Page crash or detachment",
    attribution: "indeterminate",
    causeFamily: "insufficient_evidence",
    subcategory: "page_crash_or_detachment",
    evidenceTier: "structured_text",
    description: "The page, target, or frame crashed or detached during navigation.",
    matches: (site) =>
      isBrowserTerminal(site) &&
      has(site, /page crashed|target closed|frame (?:was )?detached|page (?:was )?closed/),
  },
  {
    id: "BRW-UNMAPPED-NAVIGATION-FAILURE",
    stage: "browser",
    title: "Unmapped navigation failure",
    attribution: "indeterminate",
    causeFamily: "unclassified_outcome",
    subcategory: "unmapped_navigation_failure",
    evidenceTier: "structured_text",
    description: "Navigation or initial inspection failed for an unmapped reason.",
    matches: isBrowserTerminal,
  },
  {
    id: "DSC-CONFIRMED-QUALIFIED",
    stage: "discovery",
    title: "Confirmed form qualified in Discovery mode",
    attribution: "not_applicable",
    causeFamily: "not_applicable",
    subcategory: "qualified_not_executed",
    evidenceTier: "structured_json",
    description: "A directly validated contact form was found; later stages were intentionally not executed.",
    matches: (site) => site.mode === "discovery" && assessmentIs(site, "confirmed_form_present"),
    decide: () => ({ runState: "qualified" }),
  },
  {
    id: "DSC-CONTACT-CHANNEL-NO-FORM",
    stage: "discovery",
    title: "Contact channel without form",
    attribution: "non_workflow_attributable",
    causeFamily: "expected_no_opportunity",
    subcategory: "contact_channel_without_form",
    evidenceTier: "structured_json",
    description: "Inspection found a contact channel but no qualifying form.",
    matches: (site) => assessmentIs(site, "contact_channel_without_form"),
    decide: (site) => {
      const value = text(site);
      const subcategory = /mailto|email.only|email address/.test(value)
        ? "email_only"
        : /tel:|telephone.only|phone.only|phone number/.test(value)
          ? "telephone_only"
          : /live chat|chat.only|whatsapp/.test(value)
            ? "chat_only"
            : /external booking|booking service|calendly/.test(value)
              ? "external_booking_only"
              : /support portal|help center/.test(value)
                ? "support_portal_only"
                : /office details|office address|locations? only/.test(value)
                  ? "office_details_only"
                  : "contact_channel_without_form";
      return { subcategory };
    },
  },
  {
    id: "DSC-NO-FORM-COMPLETE",
    stage: "discovery",
    title: "No form observed after complete bounded search",
    attribution: "non_workflow_attributable",
    causeFamily: "expected_no_opportunity",
    subcategory: "no_form_observed_after_complete_search",
    evidenceTier: "structured_json",
    description: "All configured bounded checks completed and observed no form evidence.",
    matches: (site) => assessmentIs(site, "no_form_observed_after_complete_search"),
  },
  {
    id: "DSC-POLICY-BOUNDARY",
    stage: "discovery",
    title: "Discovery stopped at a policy or safety boundary",
    attribution: "non_workflow_attributable",
    causeFamily: "policy_scope_boundary",
    subcategory: "prohibited_cross_origin_or_safety_boundary",
    evidenceTier: "structured_text",
    description: "A candidate required prohibited cross-origin navigation or unsupported interaction.",
    matches: (site) =>
      site.failureKind === "discovery.booking_only" ||
      (site.failureKind.startsWith("discovery.") &&
        /cross-origin booking|top-level cross-origin|prohibited (?:interaction|navigation)|policy boundary|safety boundary/.test(
          primaryText(site),
        )),
  },
  {
    id: "DSC-STRONG-EVIDENCE",
    stage: "discovery",
    title: "Strong form evidence remained unresolved",
    attribution: "indeterminate",
    causeFamily: "insufficient_evidence",
    subcategory: "strong_form_evidence_unresolved",
    evidenceTier: "structured_json",
    description: "Strong evidence exists, but the form was not directly validated.",
    matches: (site) => assessmentIs(site, "strong_form_evidence"),
  },
  {
    id: "DSC-POSSIBLE-EVIDENCE",
    stage: "discovery",
    title: "Possible form evidence remained unresolved",
    attribution: "indeterminate",
    causeFamily: "insufficient_evidence",
    subcategory: "possible_form_evidence_unresolved",
    evidenceTier: "structured_json",
    description: "Possible form evidence exists, but it is not conclusive.",
    matches: (site) => assessmentIs(site, "possible_form_evidence"),
  },
  {
    id: "DSC-LIMITED-SEARCH",
    stage: "discovery",
    title: "No form observed after limited search",
    attribution: "indeterminate",
    causeFamily: "insufficient_evidence",
    subcategory: "no_form_observed_after_limited_search",
    evidenceTier: "structured_json",
    description: "No form was observed, but one or more promising checks could not be completed.",
    matches: (site) => assessmentIs(site, "no_form_observed_after_limited_search"),
  },
  {
    id: "DSC-INACCESSIBLE-EMBED",
    stage: "discovery",
    title: "Inaccessible frame, embed, or modal",
    attribution: "indeterminate",
    causeFamily: "insufficient_evidence",
    subcategory: "inaccessible_frame_embed_or_modal",
    evidenceTier: "structured_text",
    description: "A promising frame, embedded form, widget, or modal could not be resolved.",
    matches: (site) =>
      isDiscoveryTerminal(site) &&
      has(site, /inaccessible (?:frame|iframe|embed|modal)|cross-origin (?:frame|iframe).*inaccessible|modal.*(?:failed|unavailable)|widget.*unavailable/),
  },
  {
    id: "DSC-STAGEHAND-FAILURE",
    stage: "discovery",
    title: "Discovery fallback failure",
    attribution: "indeterminate",
    causeFamily: "insufficient_evidence",
    subcategory: "stagehand_discovery_fallback_failure",
    evidenceTier: "structured_text",
    description: "The bounded Stagehand discovery fallback failed or remained unresolved.",
    matches: (site) =>
      site.failureKind === "discovery.llm_unresolved" ||
      (isDiscoveryTerminal(site) && has(site, /stagehand.*(?:failed|timeout|unresolved)/)),
  },
  {
    id: "DSC-UNRESOLVED-ROUTE-OR-TIMEOUT",
    stage: "discovery",
    title: "Unresolved route or discovery timeout",
    attribution: "indeterminate",
    causeFamily: "insufficient_evidence",
    subcategory: "discovery_timeout_or_unresolved_route",
    evidenceTier: "structured_text",
    description: "Discovery could not resolve a promising route or completed its time budget inconclusively.",
    matches: (site) =>
      isDiscoveryTerminal(site) &&
      has(site, /discovery timeout|contact route.*(?:timeout|unresolved)|promising route.*(?:timeout|unresolved)/),
  },
  {
    id: "DSC-EMAIL-ONLY-LEGACY",
    stage: "discovery",
    title: "Email-only contact destination",
    attribution: "non_workflow_attributable",
    causeFamily: "expected_no_opportunity",
    subcategory: "email_only",
    evidenceTier: "structured_text",
    description: "Legacy full-run evidence explicitly reports an email-only destination.",
    matches: (site) => site.failureKind === "discovery.email_only",
  },
  {
    id: "DSC-REJECTED-NONCONTACT-FORM",
    stage: "discovery",
    title: "Only rejected non-contact forms were found",
    attribution: "non_workflow_attributable",
    causeFamily: "expected_no_opportunity",
    subcategory: "only_rejected_noncontact_forms",
    evidenceTier: "structured_text",
    description: "Only newsletter, search, login, or other intentionally rejected forms were observed.",
    matches: (site) => site.failureKind === "discovery.rejected_form",
  },
  {
    id: "DSC-UNCLASSIFIED-FAILURE",
    stage: "discovery",
    title: "Unclassified discovery outcome",
    attribution: "indeterminate",
    causeFamily: "unclassified_outcome",
    subcategory: "unclassified_discovery_outcome",
    evidenceTier: "bounded_text",
    description: "Discovery did not qualify a form and no more specific deterministic rule matched.",
    matches: (site) =>
      site.mode === "discovery" || site.failureKind.startsWith("discovery.") || (!assessmentIs(site, "confirmed_form_present") && site.discoveryAssessment !== ""),
  },
  {
    id: "POP-INVALID-SUPPLIED-VALUE",
    stage: "population",
    title: "Supplied value rejected during population",
    attribution: "workflow_attributable",
    causeFamily: "input_data_issue",
    subcategory: "invalid_supplied_contact_value",
    evidenceTier: "structured_text",
    description: "A supplied contact value was explicitly missing or invalid.",
    matches: (site) =>
      (site.failureKind === "population.blocked" || (site.failureKind === "runtime.error" && !site.submissionAttempted)) &&
      has(site, /supplied (?:value|email|phone|name|message).*(?:invalid|missing|empty)|invalid supplied (?:value|email|phone|name|message)/),
  },
  {
    id: "POP-EXTERNAL-FORM-UNAVAILABLE",
    stage: "population",
    title: "Form explicitly disabled, closed, or externally unavailable",
    attribution: "non_workflow_attributable",
    causeFamily: "external_site_or_service_issue",
    subcategory: "form_disabled_closed_or_widget_unavailable",
    evidenceTier: "structured_text",
    description: "The site explicitly disabled or closed the form, or its external widget was unavailable.",
    matches: (site) =>
      !site.submissionAttempted &&
      /form (?:is )?(?:disabled|closed|no longer accepting)|external widget.*unavailable|widget service.*unavailable/.test(
        [site.reason, site.description].join("\n").toLowerCase(),
      ),
  },
  {
    id: "POP-DYNAMIC-CONTRADICTORY-STATE",
    stage: "population",
    title: "Dynamic or contradictory form state",
    attribution: "indeterminate",
    causeFamily: "conflicting_evidence",
    subcategory: "dynamic_or_contradictory_form_state",
    evidenceTier: "structured_text",
    description: "The form state changed or contradicted the available evidence without a reliable cause.",
    matches: (site) =>
      (site.failureKind === "population.blocked" || (site.failureKind === "runtime.error" && !site.submissionAttempted)) &&
      has(site, /dynamic form state|contradictory form state|form (?:appeared|disappeared).*unexpected/),
  },
  {
    id: "POP-MULTISTEP-PROGRESSION",
    stage: "population",
    title: "Unhandled multi-step progression",
    attribution: "workflow_attributable",
    causeFamily: "workflow_logic_issue",
    subcategory: "multistep_progression_failure",
    evidenceTier: "structured_text",
    description: "The bounded multi-step form progression logic did not complete safely.",
    matches: (site) =>
      (site.failureKind === "population.blocked" || (site.failureKind === "runtime.error" && !site.submissionAttempted)) &&
      has(site, /multi-step|multistep|progression/),
  },
  {
    id: "POP-REQUIRED-CONTROL",
    stage: "population",
    title: "Required control unresolved",
    attribution: "workflow_attributable",
    causeFamily: "workflow_logic_issue",
    subcategory: "required_control_or_consent_unresolved",
    evidenceTier: "structured_text",
    description: "A required field, selection, or consent control was not handled.",
    matches: (site) =>
      (site.failureKind === "population.blocked" || (site.failureKind === "runtime.error" && !site.submissionAttempted)) &&
      has(site, /required (?:field|control|selection)|consent|privacy checkbox/),
  },
  {
    id: "POP-STANDARD-FIELD-UNRESOLVED",
    stage: "population",
    title: "Standard contact field unresolved",
    attribution: "workflow_attributable",
    causeFamily: "workflow_logic_issue",
    subcategory: "standard_contact_field_unresolved",
    evidenceTier: "structured_text",
    description: "A name, email, phone, message, or equivalent standard field could not be populated.",
    matches: (site) =>
      site.failureKind === "population.blocked" && has(site, /name|email|phone|message|field|populate|missing/),
  },
  {
    id: "POP-LOCATOR-OR-TIMEOUT",
    stage: "population",
    title: "Population locator, runtime, or timeout failure",
    attribution: "workflow_attributable",
    causeFamily: "workflow_logic_issue",
    subcategory: "population_locator_runtime_or_timeout",
    evidenceTier: "structured_text",
    description: "Population failed because a locator, runtime operation, or ordinary timeout was not handled.",
    matches: (site) =>
      site.failureKind === "population.blocked" ||
      (site.failureKind === "runtime.error" && !site.submissionAttempted),
  },
  {
    id: "SUB-INVALID-SUPPLIED-VALUE",
    stage: "submission",
    title: "Supplied value rejected by explicit validation",
    attribution: "workflow_attributable",
    causeFamily: "input_data_issue",
    subcategory: "supplied_value_type_or_pattern_rejected",
    evidenceTier: "structured_text",
    description: "The site explicitly rejected the type or pattern of a supplied contact value.",
    matches: (site) =>
      site.failureKind === "submission.validation" && has(site, /type mismatch|pattern mismatch|invalid (?:email|phone|url)|supplied value/),
  },
  {
    id: "SUB-CAPTCHA-OR-PROHIBITED",
    stage: "submission",
    title: "CAPTCHA or prohibited interaction blocked submission",
    attribution: "non_workflow_attributable",
    causeFamily: "policy_scope_boundary",
    subcategory: "captcha_or_prohibited_interaction",
    evidenceTier: "structured_text",
    description: "Submission required CAPTCHA solving or another prohibited interaction.",
    matches: (site) =>
      site.failureKind === "submission.captcha" ||
      /(?:captcha|recaptcha|hcaptcha|prohibited interaction).*(?:blocked|required|prevented)|(?:blocked|required|prevented).*(?:captcha|recaptcha|hcaptcha|prohibited interaction)/.test(
        [site.reason, site.description].join("\n").toLowerCase(),
      ),
  },
  {
    id: "SUB-EXTERNAL-REJECTION",
    stage: "submission",
    title: "External service rejected or could not accept submission",
    attribution: "non_workflow_attributable",
    causeFamily: "external_site_or_service_issue",
    subcategory: "server_rate_limit_closed_form_or_external_rejection",
    evidenceTier: "structured_text",
    description: "A server outage, rate limit, closed form, or external service explicitly rejected the submission.",
    matches: (site) =>
      /server (?:outage|error)|rate limit|too many requests|http 429|form (?:is )?closed|no longer accepting|external service.*reject/.test(
        [site.reason, site.description].join("\n").toLowerCase(),
      ),
  },
  {
    id: "SUB-NO-CONTROL",
    stage: "submission",
    title: "Submit control missing, rejected, or non-actionable",
    attribution: "workflow_attributable",
    causeFamily: "workflow_logic_issue",
    subcategory: "submit_control_missing_rejected_or_nonactionable",
    evidenceTier: "structured_text",
    description: "The workflow could not find or safely activate a valid submit control.",
    matches: (site) => site.failureKind === "submission.no_control",
  },
  {
    id: "SUB-PREFLIGHT-OR-OBSTRUCTION",
    stage: "submission",
    title: "Submission preflight or obstruction failure",
    attribution: "workflow_attributable",
    causeFamily: "workflow_logic_issue",
    subcategory: "submission_preflight_or_obstruction_failure",
    evidenceTier: "structured_text",
    description: "The form or submit control did not stabilize, or an ordinary obstruction was not cleared.",
    matches: (site) =>
      site.failureKind === "submission.preflight" ||
      (!site.failureKind && /obstruction|intercepted|preflight.*(?:failed|unstable)/.test(primaryText(site))),
  },
  {
    id: "SUB-BROWSER-VALIDATION",
    stage: "submission",
    title: "Validation caused by incomplete population",
    attribution: "workflow_attributable",
    causeFamily: "workflow_logic_issue",
    subcategory: "browser_validation_after_population",
    evidenceTier: "structured_text",
    description: "Browser or form validation blocked submission without proof of invalid source data.",
    matches: (site) => site.failureKind === "submission.validation",
  },
  {
    id: "SUB-POST-VALIDATION-REJECTION",
    stage: "submission",
    title: "Post-submit validation explicitly rejected submission",
    attribution: "workflow_attributable",
    causeFamily: "workflow_logic_issue",
    subcategory: "post_submit_validation_rejection",
    evidenceTier: "structured_text",
    description:
      "The site displayed a new required-field or supplied-value rejection after activation.",
    matches: (site) =>
      site.failureKind === "submission.rejected" &&
      has(site, /post-submit validation|rejection evidence:.*validation/),
  },
  {
    id: "SUB-SERVER-REJECTION",
    stage: "submission",
    title: "Form service explicitly rejected submission",
    attribution: "non_workflow_attributable",
    causeFamily: "external_site_or_service_issue",
    subcategory: "post_submit_server_rejection",
    evidenceTier: "structured_text",
    description:
      "A correlated form service returned explicit failure evidence.",
    matches: (site) =>
      site.failureKind === "submission.rejected" &&
      has(site, /form service|rejection evidence:.*server/),
  },
  {
    id: "SUB-EXPLICIT-REJECTION",
    stage: "submission",
    title: "Submission explicitly rejected",
    attribution: "indeterminate",
    causeFamily: "insufficient_evidence",
    subcategory: "post_submit_explicit_rejection",
    evidenceTier: "structured_text",
    description:
      "A new post-click error explicitly rejected submission without enough evidence to attribute the cause.",
    matches: (site) => site.failureKind === "submission.rejected",
  },
  {
    id: "SUB-CONTRADICTORY-EVIDENCE",
    stage: "submission",
    title: "Submission produced contradictory evidence",
    attribution: "indeterminate",
    causeFamily: "insufficient_evidence",
    subcategory: "submission_contradictory_evidence",
    evidenceTier: "structured_text",
    description:
      "Strong confirmation and rejection evidence were both observed for the same submission attempt.",
    matches: (site) => site.failureKind === "submission.contradictory",
  },
  {
    id: "SUB-UNCONFIRMED",
    stage: "submission",
    title: "Submission attempted but unconfirmed",
    attribution: "indeterminate",
    causeFamily: "insufficient_evidence",
    subcategory: "submission_unconfirmed",
    evidenceTier: "structured_text",
    description: "Submission was attempted, but UI, URL, and network evidence did not prove success or failure.",
    matches: (site) =>
      site.failureKind === "submission.unconfirmed" ||
      site.failureKind === "submission.inconclusive" ||
      statusIs(site, "inconclusive") ||
      statusIs(site, "partial"),
  },
  {
    id: "SUB-TIMEOUT-OR-AMBIGUOUS-STATE",
    stage: "submission",
    title: "Submission timeout or ambiguous post-click state",
    attribution: "indeterminate",
    causeFamily: "insufficient_evidence",
    subcategory: "submission_timeout_or_ambiguous_postclick_state",
    evidenceTier: "structured_text",
    description: "The post-click state or network evidence was ambiguous.",
    matches: (site) =>
      Boolean(site.submissionAttempted) && has(site, /timeout|timed out|ambiguous network|unclear post-click|post-click state/),
  },
  {
    id: "SUB-UNMAPPED-FAILURE",
    stage: "submission",
    title: "Unmapped submission outcome",
    attribution: "indeterminate",
    causeFamily: "unclassified_outcome",
    subcategory: "unmapped_submission_outcome",
    evidenceTier: "bounded_text",
    description: "Submission did not succeed and no more specific deterministic rule matched.",
    matches: (site) => Boolean(site.submissionAttempted) || site.failureKind.startsWith("submission."),
  },
  {
    id: "RPT-ARTIFACT-OR-CHECKPOINT-FAILURE",
    stage: "reporting",
    title: "Reporting, artifact, queue, or checkpoint failure",
    attribution: "workflow_attributable",
    causeFamily: "reporting_issue",
    subcategory: "artifact_queue_checkpoint_or_summary_failure",
    evidenceTier: "structured_text",
    description: "An explicit report-write, queue, checkpoint, or batch-summary failure occurred.",
    matches: (site) => has(site, /report(?:ing)? (?:failed|failure)|artifact write|queue (?:update|write).*fail|checkpoint.*fail|batch summary.*fail/),
  },
  {
    id: "RPT-MALFORMED-PRIMARY-ARTIFACT",
    stage: "reporting",
    title: "Malformed primary result artifact",
    attribution: "workflow_attributable",
    causeFamily: "reporting_issue",
    subcategory: "malformed_or_inconsistent_primary_report",
    evidenceTier: "structured_json",
    description: "A primary result exists but cannot be parsed reliably.",
    matches: (site) => site.primaryArtifactMalformed,
  },
  {
    id: "RPT-FULL-SUCCESS",
    stage: "reporting",
    title: "Full workflow completed successfully",
    attribution: "not_applicable",
    causeFamily: "not_applicable",
    subcategory: "full_run_success",
    evidenceTier: "structured_text",
    description: "The Full run reports a confirmed successful submission.",
    matches: (site) => site.mode === "full" && (statusIs(site, "success") || statusIs(site, "succeeded")),
    decide: () => ({ runState: "completed" }),
  },
  {
    id: "RPT-UNCLASSIFIED-OUTCOME",
    stage: "reporting",
    title: "Unclassified terminal outcome",
    attribution: "indeterminate",
    causeFamily: "unclassified_outcome",
    subcategory: "unclassified_terminal_outcome",
    evidenceTier: "bounded_text",
    description: "A terminal artifact exists but no deterministic rule safely explains its outcome.",
    matches: () => true,
  },
];

const rulePriority = (id: string): number => {
  if (id === "DAT-CONFLICTING-STRUCTURED-EVIDENCE") return 10;
  if (id.startsWith("INP-")) return 20;
  if (id === "RPT-MALFORMED-PRIMARY-ARTIFACT") return 25;
  if (id === "RPT-FULL-SUCCESS") return 30;
  if (id === "DSC-CONFIRMED-QUALIFIED") return 31;
  if (
    [
      "DSC-CONTACT-CHANNEL-NO-FORM",
      "DSC-NO-FORM-COMPLETE",
      "DSC-STRONG-EVIDENCE",
      "DSC-POSSIBLE-EVIDENCE",
      "DSC-LIMITED-SEARCH",
    ].includes(id)
  ) {
    return 40;
  }
  return 100;
};

const orderedRules: OrderedRule[] = baseRules
  .map((rule, sourceOrder) => ({ rule, sourceOrder }))
  .sort((left, right) => rulePriority(left.rule.id) - rulePriority(right.rule.id) || left.sourceOrder - right.sourceOrder)
  .map(({ rule }, index) => ({ ...rule, order: index + 1 }));

export const serializedRulebook = {
  version: RULEBOOK_VERSION,
  firstMatchWins: true,
  definitions: {
    workflow_attributable: "A permitted automated success path existed, but input, workflow logic, local execution, or reporting prevented it.",
    non_workflow_attributable: "No permitted automated success path existed during the run because no qualifying opportunity existed, the site/service prevented it, or policy forbade the required action.",
    indeterminate: "The artifacts do not contain enough consistent evidence to assign responsibility safely.",
    not_applicable: "The site succeeded or qualified, so responsibility attribution does not apply.",
  },
  rules: orderedRules.map(({ matches: _matches, decide: _decide, ...rule }) => rule),
};

const blankStageStates = (): Record<TerminalStage, StageState> => ({
  input: "not_entered",
  browser: "not_entered",
  discovery: "not_entered",
  population: "not_entered",
  submission: "not_entered",
  reporting: "not_entered",
});

const buildStageStates = (site: SiteEvidence, decision: Decision): Record<TerminalStage, StageState> => {
  const states = blankStageStates();
  if (decision.runState === "incomplete") {
    states.input = site.inputPath ? "advanced" : "incomplete";
    states.reporting = "incomplete";
    return states;
  }

  const terminalIndex = STAGES.indexOf(decision.terminalStage);
  for (let index = 0; index < STAGES.length; index += 1) {
    const stage = STAGES[index];
    if (!stage) continue;
    if (site.mode === "discovery" && (stage === "population" || stage === "submission")) {
      states[stage] = "not_applicable";
      continue;
    }
    if (stage === "reporting") {
      states.reporting = site.primaryTextPath || site.primaryJsonPath ? "completed" : "incomplete";
      continue;
    }
    if (index < terminalIndex) states[stage] = "advanced";
    else if (index === terminalIndex) {
      states[stage] = decision.runState === "qualified" ? "qualified_not_executed" : decision.runState === "completed" ? "completed" : "stopped";
    }
  }

  if (decision.runState === "completed") {
    states.input = "advanced";
    states.browser = "advanced";
    states.discovery = "advanced";
    states.population = "advanced";
    states.submission = "advanced";
    states.reporting = "completed";
  }
  return states;
};

export const classifySite = (site: SiteEvidence): SiteClassification => {
  if (site.hasOnlyInput) {
    const decision: Decision = {
      ruleId: "RUN-INCOMPLETE-INPUT-ONLY",
      runState: "incomplete",
      terminalStage: "reporting",
      attribution: "not_applicable",
      causeFamily: "not_applicable",
      subcategory: "input_only_without_explicit_cause",
      evidenceBasis: "artifact_absence",
      evidenceSummary: "The site directory contains input but no primary result artifact; no cause is inferred.",
      primaryCause: "No terminal result artifact was recorded.",
    };
    return {
      id: site.id,
      numericId: site.numericId,
      websiteUrl: site.websiteUrl,
      sourceDirectory: site.directory,
      mode: site.mode,
      runState: decision.runState,
      terminalStage: decision.terminalStage,
      attribution: decision.attribution,
      causeFamily: decision.causeFamily,
      subcategory: decision.subcategory,
      ruleId: decision.ruleId,
      evidenceBasis: decision.evidenceBasis,
      evidenceSummary: decision.evidenceSummary,
      sourcePaths: site.sourcePaths,
      primaryCause: decision.primaryCause,
      secondarySignals: [],
      status: site.status,
      failureKind: site.failureKind,
      discoveryAssessment: site.discoveryAssessment,
      stageStates: buildStageStates(site, decision),
    };
  }

  const rule = orderedRules.find((candidate) => candidate.matches(site));
  if (!rule) throw new Error(`Rulebook has no terminal rule for site ${site.id}.`);
  const override = rule.decide?.(site) ?? {};
  const hasApplicableJsonEvidence = Boolean(site.primaryJsonPath || (rule.id.startsWith("INP-") && site.inputPath));
  const resolvedEvidenceBasis: EvidenceTier =
    rule.evidenceTier === "structured_json" && !hasApplicableJsonEvidence ? "structured_text" : rule.evidenceTier;
  const decision: Decision = {
    ruleId: rule.id,
    runState: "stopped",
    terminalStage: rule.stage,
    attribution: rule.attribution,
    causeFamily: rule.causeFamily,
    subcategory: rule.subcategory,
    evidenceBasis: resolvedEvidenceBasis,
    evidenceSummary: site.reason || site.description || rule.description,
    primaryCause: site.reason || site.description || rule.title,
    ...override,
  };

  const secondarySignals = [
    site.searchCoverage ? `searchCoverage=${site.searchCoverage}` : "",
    site.presenceEvidenceStrength ? `presenceEvidenceStrength=${site.presenceEvidenceStrength}` : "",
    site.failureKind ? `failureKind=${site.failureKind}` : "",
  ].filter(Boolean);

  return {
    id: site.id,
    numericId: site.numericId,
    websiteUrl: site.websiteUrl,
    sourceDirectory: site.directory,
    mode: site.mode,
    runState: decision.runState,
    terminalStage: decision.terminalStage,
    attribution: decision.attribution,
    causeFamily: decision.causeFamily,
    subcategory: decision.subcategory,
    ruleId: decision.ruleId,
    evidenceBasis: decision.evidenceBasis,
    evidenceSummary: decision.evidenceSummary,
    sourcePaths: site.sourcePaths,
    primaryCause: decision.primaryCause,
    secondarySignals,
    status: site.status,
    failureKind: site.failureKind,
    discoveryAssessment: site.discoveryAssessment,
    stageStates: buildStageStates(site, decision),
  };
};
