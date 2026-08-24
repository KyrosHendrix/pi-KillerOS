type CodexFastStateListener = () => void;

interface CodexFastState {
  enabled: boolean;
  listeners: Set<CodexFastStateListener>;
}

const GLOBAL_STATE_KEY = "__killerosCodexFastState";
type GlobalWithCodexFastState = typeof globalThis & {
  [GLOBAL_STATE_KEY]?: unknown;
};

// Accepts process-global state only when it is safe to reuse across extension versions.
function isCodexFastState(value: unknown): value is CodexFastState {
  return typeof value === "object" && value !== null
    && "enabled" in value && typeof value.enabled === "boolean"
    && "listeners" in value && value.listeners instanceof Set
    && [...value.listeners].every((listener) => typeof listener === "function");
}

const globalState = globalThis as GlobalWithCodexFastState;
const savedState = globalState[GLOBAL_STATE_KEY];
const state: CodexFastState = isCodexFastState(savedState) ? savedState : {
  enabled: typeof savedState === "object" && savedState !== null
    && "enabled" in savedState && savedState.enabled === true,
  listeners: new Set<CodexFastStateListener>(),
};
globalState[GLOBAL_STATE_KEY] = state;

export function isCodexFastEnabled(): boolean {
  return state.enabled;
}

export function toggleCodexFast(): boolean {
  state.enabled = !state.enabled;
  for (const listener of [...state.listeners]) listener();
  return state.enabled;
}

export function subscribeCodexFast(listener: CodexFastStateListener): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/** Test-only reset for the process-global state between isolated harnesses. */
export function resetCodexFastState(): void {
  state.enabled = false;
  state.listeners.clear();
}
