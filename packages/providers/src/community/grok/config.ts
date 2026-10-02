import { clampEffort, isEffortRung } from '@archon/paths/effort';
import {
  assertKnownRunConfigKeys,
  invalidRunConfigValue,
  normalizeRunConfigString,
} from '../../shared/run-config';

/** The rungs of Archon's effort ladder Grok's `--effort` accepts. */
export const GROK_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type GrokEffort = (typeof GROK_EFFORTS)[number];

/** `assistants.grok` defaults. */
export interface GrokProviderDefaults {
  [key: string]: unknown;
  /** Default model, e.g. 'grok-4.7'. Omitted: Grok's own default. */
  model?: string;
  /** Default reasoning effort, used when a node declares none. */
  modelReasoningEffort?: GrokEffort;
  /** Path to the grok binary. Overrides ARCHON_GROK_EXECUTABLE and auto-detection. */
  grokBinaryPath?: string;
}

/** Tolerant parse: fields with unexpected types are dropped. */
export function parseGrokConfig(raw: Record<string, unknown>): GrokProviderDefaults {
  const config: GrokProviderDefaults = {};
  if (typeof raw.model === 'string' && raw.model.trim()) config.model = raw.model.trim();
  const effort = clampEffort(raw.modelReasoningEffort, GROK_EFFORTS);
  if (effort !== undefined) config.modelReasoningEffort = effort;
  if (typeof raw.grokBinaryPath === 'string' && raw.grokBinaryPath.trim()) {
    config.grokBinaryPath = raw.grokBinaryPath.trim();
  }
  return config;
}

/** Strict counterpart for authored config: `.archon/config.yaml` and per-run layers. */
export function parseGrokConfigStrict(raw: Record<string, unknown>): GrokProviderDefaults {
  assertKnownRunConfigKeys(raw, ['model', 'modelReasoningEffort', 'grokBinaryPath']);
  const model = normalizeRunConfigString(raw.model, 'model');
  const grokBinaryPath = normalizeRunConfigString(raw.grokBinaryPath, 'grokBinaryPath');
  if (raw.modelReasoningEffort !== undefined && !isEffortRung(raw.modelReasoningEffort)) {
    invalidRunConfigValue('modelReasoningEffort', 'a valid Archon effort level');
  }
  return {
    ...parseGrokConfig(raw),
    ...(model === undefined ? {} : { model }),
    ...(grokBinaryPath === undefined ? {} : { grokBinaryPath }),
  };
}
