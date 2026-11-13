// MicatCode fork branding constants.
// Mirrors how Kiro rebranded Continue (title + "kiroAgent" namespace).
// NOTE: renaming the cross-cutting command/protocol namespace (continue.* ->
// micatcode.*) in core/extension is a separate, larger change and is NOT
// done here to avoid desync with the extension host.

export const BRAND_NAME = "MicatCode";
export const BRAND_TITLE = "MicatCode";
// Hidden workspace dir that stores MicatCode feature files
// (mirrors Kiro's `.kiro/`). Steering/Specs/Hooks/Power live here.
export const BRAND_WORKSPACE_DIR = ".micat";
// Use this for any NEW protocol events added on the GUI side, e.g.
// `${BRAND_NAMESPACE}/someEvent`. Existing core events stay as-is.
export const BRAND_NAMESPACE = "micatcode";
