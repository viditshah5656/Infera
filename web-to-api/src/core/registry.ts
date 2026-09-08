import { BaseProvider, type ModelInfo } from './provider.js';
import { InvalidModelError } from './errors.js';

export interface ProviderStatus {
  id: string;
  name: string;
  website: string;
  authenticated: boolean;
  modelCount: number;
}

export class ProviderRegistry {
  private providers = new Map<string, BaseProvider>();

  register(provider: BaseProvider): void {
    this.providers.set(provider.info.id, provider);
  }

  async resolve(modelId: string): Promise<{ provider: BaseProvider; model: string }> {
    const slashIndex = modelId.indexOf('/');

    // Explicit provider/model format
    if (slashIndex > 0 && slashIndex < modelId.length - 1) {
      const providerId = modelId.slice(0, slashIndex);
      const model = modelId.slice(slashIndex + 1);

      const provider = this.providers.get(providerId);
      if (provider) {
        return { provider, model };
      }
      // provider not found — fall through to fuzzy match
    }

    // Fuzzy match: exact or case-insensitive search
    const lowerId = modelId.toLowerCase();
    for (const [, provider] of this.providers) {
      const models = await provider.models();
      const matched = models.find((m) => m.id === modelId || m.id.toLowerCase() === lowerId);
      if (matched) {
        return { provider, model: matched.id };
      }
    }

    // Prefix-based fallback to known providers
    if (/^(gpt-|o[0-9]|gpt-oss)/i.test(modelId)) {
      const p = this.providers.get('chatgpt-web');
      if (p) return { provider: p, model: modelId };
    }
    if (/^(qwen|qwq)/i.test(modelId)) {
      const p = this.providers.get('qwen-web');
      if (p) return { provider: p, model: modelId };
    }
    if (/^(kimi|moonshot)/i.test(modelId)) {
      const p = this.providers.get('kimi-web');
      if (p) return { provider: p, model: modelId };
    }
    if (/^deepseek/i.test(modelId)) {
      const p = this.providers.get('deepseek-web');
      if (p) return { provider: p, model: modelId };
    }

    throw new InvalidModelError(modelId);
  }

  async allModels(): Promise<(ModelInfo & { id: string })[]> {
    const result: (ModelInfo & { id: string })[] = [];
    const seenIds = new Set<string>();

    for (const [providerId, provider] of this.providers) {
      if (!(await provider.isAuthenticated())) continue;
      const models = await provider.models();
      for (const m of models) {
        // Add prefixed ID: provider/model
        result.push({ ...m, id: `${providerId}/${m.id}` });
        // Also add bare ID if not already added
        if (!seenIds.has(m.id)) {
          seenIds.add(m.id);
          result.push({ ...m, id: m.id });
        }
      }
    }

    return result;
  }

  async providerStatus(): Promise<ProviderStatus[]> {
    const result: ProviderStatus[] = [];

    for (const [, provider] of this.providers) {
      const authenticated = await provider.isAuthenticated();
      let modelCount = 0;
      if (authenticated) {
        modelCount = (await provider.models()).length;
      }
      result.push({
        id: provider.info.id,
        name: provider.info.name,
        website: provider.info.website,
        authenticated,
        modelCount,
      });
    }

    return result;
  }

  getProvider(id: string): BaseProvider | undefined {
    return this.providers.get(id);
  }
}
