type CodexFastStateListener = () => void;

interface CodexFastState {
  enabled: boolean;
  listeners: Set<CodexFastStateListener>;
}

const GLOBAL_STATE_KEY = "__killerosCodexFastState";
type GlobalWithCodexFastState = typeof globalThis & {
  [GLOBAL_STATE_KEY]?: CodexFastState;
};

const globalState = globalThis as GlobalWithCodexFastState;
const state = globalState[GLOBAL_STATE_KEY] ??= {
  enabled: false,
  listeners: new Set<CodexFastStateListener>(),
};

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
