import type { ProviderType } from './schemas/provider';

export function isClaudeModel(model: string): boolean {
  return (
    model === 'sonnet' ||
    model === 'opus' ||
    model === 'haiku' ||
    model === 'inherit' ||
    model.startsWith('claude-')
  );
}

export function isModelCompatible(provider: ProviderType, model?: string): boolean {
  if (!model) return true;

  switch (provider) {
    case 'claude':
      return isClaudeModel(model);
    case 'codex':
      // Codex: accept most models, but reject obvious Claude aliases/prefixes
      return !isClaudeModel(model);
    case 'openrouter':
      // OpenRouter: accept vendor/model format; reject Claude aliases
      return !isClaudeModel(model);
    case 'llamacpp':
      // Llama.cpp: accept any string (model loaded server-side); reject Claude aliases
      return !isClaudeModel(model);
  }
}
