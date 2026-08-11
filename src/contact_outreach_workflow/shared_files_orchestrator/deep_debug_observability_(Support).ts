/*
 * Channel-neutral entry point for the deep-debug recorder. The legacy forms
 * path remains available so existing imports and artifact consumers continue
 * to work while lifecycle ownership resides in the macro orchestrator.
 */
export { create_deep_debug_context } from
  "../contact_channels/forms/shared_files_forms/deep_debug_observability_(Support).js";
