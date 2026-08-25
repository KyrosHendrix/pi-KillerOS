import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

// Pi does not expose constructible test hosts; the installed-package lifecycle test supplies the real runtime proof.
export function extensionApiTestAdapter(testDouble: object): ExtensionAPI {
  return testDouble as ExtensionAPI;
}

// Context-only tests provide the exact method under test while Pi owns the rest of the host object.
export function extensionContextTestAdapter(testDouble: object): ExtensionContext {
  return testDouble as ExtensionContext;
}

// Command-context tests provide the exact method under test while Pi owns the rest of the host object.
export function extensionCommandContextTestAdapter(testDouble: object): ExtensionCommandContext {
  return testDouble as ExtensionCommandContext;
}

// Theme tests provide only exercised style methods because Pi does not export an initialized test theme.
export function themeTestAdapter(testDouble: object): Theme {
  return testDouble as Theme;
}
