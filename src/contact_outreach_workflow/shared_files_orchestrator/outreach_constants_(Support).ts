/*
 * ========================================================================
 * SHARED AUTOMATION CONSTANTS
 * ========================================================================
 * Centralizes fixed CLI defaults, browser timeouts, scoring thresholds, and
 * CLI settings used across workflow stages.
 * ========================================================================
 */

export const DEFAULT_INPUT_PATH = "input/websites.json";
export const DEFAULT_OUTPUT_PATH = "output/result.txt";
export const SHARED_INPUT_DIRECTORY = "input";
export const DEFAULT_CONTACT_VALUES_PATH = "input/contact-values.json";
export const DEFAULT_SHARED_INPUT_PATH = "input/websites.json";
export const DEFAULT_PRODUCTION_OUTPUT_PATH = "output/production-result.txt";
export const DEFAULT_DEEP_DEBUG_OUTPUT_PATH = "output/deep-debug-result.txt";
export const RUN_MODE_ENVIRONMENT_VARIABLE = "CONTACT_FORM_RUN_MODE";
export const AUTOMATION_ENGINE_ENVIRONMENT_VARIABLE = "CONTACT_FORM_ENGINE";
export const OPENROUTER_MODEL_ENVIRONMENT_VARIABLE = "OPENROUTER_MODEL";
export const OPENROUTER_API_KEY_FILE_ENVIRONMENT_VARIABLE =
  "OPENROUTER_API_KEY_FILE";
export const DEFAULT_OPENROUTER_API_KEY_FILE =
  "C:\\Users\\olegl\\Documents\\LS\\JavaCommons\\src\\main\\java\\com\\leadspotting\\commons\\services\\chatGPT\\AbstractChatGPT.java";

export const NAVIGATION_TIMEOUT_MS = 15_000;
export const ACTION_TIMEOUT_MS = 5_000;
export const CONFIRMATION_TIMEOUT_MS = 4_000;
export const SUBMIT_PREFLIGHT_ATTEMPTS = 3;
export const SUBMIT_GEOMETRY_SAMPLE_COUNT = 3;
export const SUBMIT_GEOMETRY_SAMPLE_INTERVAL_MS = 150;
export const SUBMIT_LAYOUT_SETTLE_MS = 150;
export const DEBUG_ACTION_SLOW_MO_MS = 0;
export const AI_OBSERVE_TIMEOUT_MS = 30_000;
export const AI_ACTION_TIMEOUT_MS = 15_000;
export const MAX_AI_DISCOVERY_ACTIONS = 2;
export const MAX_AI_POPULATION_ACTIONS = 10;

export const MAX_CONTACT_LINKS = 3;
export const MINIMUM_CONTACT_FORM_SCORE = 7;

export function resolve_site_watchdog_timeout(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const configured = Number(environment.CONTACT_FORM_SITE_TIMEOUT_MS ?? "300000");
  if (!Number.isFinite(configured) || configured < 30_000) return 300_000;
  return Math.floor(configured);
}

export function is_contact_form_debug_enabled(): boolean {
  return process.env.DEBUG_CONTACT_FORM === "1";
}
