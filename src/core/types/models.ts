/**
 * Model type definitions and constants.
 */

/** Model identifier (string to support custom models via environment variables). */
export type CodexModel = string;

export const DEFAULT_CODEX_MODELS: { value: CodexModel; label: string; description: string }[] = [
  { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Most capable general-purpose model' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', description: 'Strong coding and agentic workflows' },
  { value: 'gpt-5.2', label: 'GPT-5.2', description: 'Balanced reasoning and reliability' },
  { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', description: 'Fast and lightweight coding model' },
];

export type ThinkingBudget = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

export const THINKING_BUDGETS: { value: ThinkingBudget; label: string; tokens: number }[] = [
  { value: 'off', label: 'Off', tokens: 0 },
  { value: 'low', label: 'Low', tokens: 4000 },
  { value: 'medium', label: 'Med', tokens: 8000 },
  { value: 'high', label: 'High', tokens: 16000 },
  { value: 'xhigh', label: 'Ultra', tokens: 32000 },
];

/** Effort levels for adaptive thinking models. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

export const EFFORT_LEVELS: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

/** Default effort level per model tier. */
export const DEFAULT_EFFORT_LEVEL: Record<string, EffortLevel> = {
  'gpt-5.4': 'high',
  'gpt-5.3-codex': 'high',
  'gpt-5.2': 'high',
  'gpt-5.1-codex-mini': 'medium',
};

/** Default thinking budget per model tier. */
export const DEFAULT_THINKING_BUDGET: Record<string, ThinkingBudget> = {
  'gpt-5.4': 'medium',
  'gpt-5.3-codex': 'medium',
  'gpt-5.2': 'low',
  'gpt-5.1-codex-mini': 'low',
};

const DEFAULT_MODEL_VALUES = new Set(DEFAULT_CODEX_MODELS.map(m => m.value));

/** Whether the model is a known Codex-compatible model that supports adaptive thinking. */
export function isAdaptiveThinkingModel(model: string): boolean {
  if (DEFAULT_MODEL_VALUES.has(model)) return true;
  return /gpt-5(\.[0-9]+)?(?:-[a-z0-9.-]+)?/i.test(model);
}

export const CONTEXT_WINDOW_STANDARD = 200_000;
export const CONTEXT_WINDOW_1M = 1_000_000;

export function filterVisibleModelOptions<T extends { value: string }>(
  models: T[],
  enableGPT54HighContext: boolean,
  enableGPT53CodexHighContext: boolean
): T[] {
  void enableGPT54HighContext;
  void enableGPT53CodexHighContext;
  return models.filter((model) => {
    return true;
  });
}

export function normalizeVisibleModelVariant(
  model: string,
  enableGPT54HighContext: boolean,
  enableGPT53CodexHighContext: boolean
): string {
  void enableGPT54HighContext;
  void enableGPT53CodexHighContext;
  return model;
}

export function getContextWindowSize(
  model: string,
  customLimits?: Record<string, number>
): number {
  if (customLimits && model in customLimits) {
    const limit = customLimits[model];
    if (typeof limit === 'number' && limit > 0 && !isNaN(limit) && isFinite(limit)) {
      return limit;
    }
  }

  if (model.endsWith('[1m]')) {
    return CONTEXT_WINDOW_1M;
  }

  return CONTEXT_WINDOW_STANDARD;
}
