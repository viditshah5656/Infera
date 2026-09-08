import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { QWEN_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';
import type { Page } from 'playwright-core';

// ======Settings=========
const QWEN_CONTEXT_WINDOW = 1_000_000;
const QWEN_MAX_OUTPUT = 8192;
const QWEN_DEFAULT_MODEL = 'qwen3.7-plus';
const QWEN_RESPONSE_TIMEOUT_MS = 90_000;
const QWEN_KNOWN_MODELS: ModelInfo[] = [
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', contextWindow: QWEN_CONTEXT_WINDOW, maxOutput: 65_536 },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max', contextWindow: QWEN_CONTEXT_WINDOW, maxOutput: 81_920 },
  { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', contextWindow: QWEN_CONTEXT_WINDOW, maxOutput: 65_536 },
  { id: 'qwen-plus', name: 'Qwen-Plus', contextWindow: QWEN_CONTEXT_WINDOW, maxOutput: 65_536 },
  { id: 'qwen-max', name: 'Qwen-Max', contextWindow: QWEN_CONTEXT_WINDOW, maxOutput: 81_920 },
  { id: 'qwen-turbo', name: 'Qwen-Turbo', contextWindow: QWEN_CONTEXT_WINDOW, maxOutput: 65_536 },
  { id: 'qwen2.5-72b', name: 'Qwen2.5-72B', contextWindow: QWEN_CONTEXT_WINDOW, maxOutput: 65_536 },
  { id: 'qwq-32b', name: 'QwQ-32B (Reasoning)', contextWindow: QWEN_CONTEXT_WINDOW, maxOutput: 65_536 },
];
const QWEN_MODEL_ALIASES: Record<string, string> = {
  'qwen3-7-plus': 'qwen3.7-plus',
  'qwen3-7-max': 'qwen3.7-max',
  'qwen3-6-plus': 'qwen3.6-plus',
  'qwen-3.5-plus': 'qwen3.7-plus',
  'qwen-plus': 'qwen3.7-plus',
  'qwen-max': 'qwen3.7-max',
  'qwen-turbo': 'qwen3.6-plus',
  'qwen2.5-72b': 'qwen3.7-plus',
  'qwen-2.5-72b': 'qwen3.7-plus',
  'qwq': 'qwen3.7-plus',
  'qwq-32b': 'qwen3.7-plus',
  'qwen': 'qwen3.7-plus',
};
// ======Settings=========

let qwenModelCache: ModelInfo[] | null = null;

export class QwenProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'qwen-web',
    name: 'Qwen Web (No Login)',
    website: 'https://chat.qwen.ai',
    loginUrl: 'https://chat.qwen.ai',
    needsBrowser: true,
  };

  constructor(
    _authStore: AuthStore,
    private browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
    private getPage?: (origin: string) => Promise<Page>,
  ) {
    super();
  }

  async login(_context: { openUrl: (url: string) => Promise<void> }): Promise<void> {
    // No login needed — anonymous access
  }

  async isAuthenticated(): Promise<boolean> {
    return Boolean(this.getPage || this.browserFetch);
  }

  async detectLoginComplete(): Promise<boolean> {
    return true;
  }

  async models(): Promise<ModelInfo[]> {
    if (qwenModelCache) return qwenModelCache;
    if (!this.getPage) return QWEN_KNOWN_MODELS;

    try {
      const page = await this.getPage(QWEN_WEB_BASE_URL);
      qwenModelCache = await loadQwenModels(page);
      return qwenModelCache;
    } catch {
      return QWEN_KNOWN_MODELS;
    }
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.getPage && !this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    try {
      const page = this.getPage
        ? await this.getPage(QWEN_WEB_BASE_URL)
        : null;

      if (!page) {
        yield { type: 'error', message: 'Qwen requires getPage for multi-step API' };
        return;
      }

      const prompt = buildWebPrompt(req.messages, req.featureInstruction);

      const modelName = resolveQwenModel(req.model);
      const requestId = `qwen_${Date.now()}_${crypto.randomUUID()}`;
      console.log(`[Qwen] chat() called: model=${modelName}, prompt="${prompt.slice(0, 40)}...", currentUrl=${page.url()}`);

      if (!page.url().includes('qwen.ai')) {
        console.log('[Qwen] Navigating to QWEN_WEB_BASE_URL...');
        await page.goto(QWEN_WEB_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(5000);
      }
      await dismissQwenModals(page);
      qwenModelCache = await loadQwenModels(page).catch(() => qwenModelCache || QWEN_KNOWN_MODELS);
      await installQwenFetchInterceptor(page, requestId, modelName);
      await selectQwenModel(page, modelName);
      console.log('[Qwen] Filling input...');
      await fillQwenInput(page, prompt);
      console.log('[Qwen] Input filled! Pressing Enter...');
      
      // Press Enter to submit
      await page.keyboard.press('Enter');
      console.log('[Qwen] Enter pressed! Polling for stream...');

      let textOffset = 0;
      let thoughtOffset = 0;
      const startedAt = Date.now();
      while (Date.now() - startedAt < QWEN_RESPONSE_TIMEOUT_MS) {
        await page.waitForTimeout(250);
        const captured = await readQwenCapturedResponse(page, requestId);
        if (captured.error) {
          console.log('[Qwen] Captured error:', captured.error);
          yield { type: 'error', message: `Qwen API error: ${captured.error}` };
          await dismissQwenModals(page);
          return;
        }
        for (const thought of captured.thoughts.slice(thoughtOffset)) {
          yield { type: 'thinking_delta', delta: thought };
        }
        thoughtOffset = captured.thoughts.length;
        for (const chunk of captured.chunks.slice(textOffset)) {
          yield { type: 'text_delta', delta: chunk };
        }
        textOffset = captured.chunks.length;
        if (captured.complete && (captured.chunks.length > 0 || captured.thoughts.length > 0)) {
          yield { type: 'done', reason: captured.finishReason === 'length' ? 'length' : 'stop' };
          await cleanupQwenCapturedResponse(page, requestId);
          // Dismiss any Welcome/login modal that pops up after completion
          await dismissQwenModals(page);
          return;
        }
      }

      yield { type: 'error', message: 'Qwen response timeout: no completion stream captured' };
      await cleanupQwenCapturedResponse(page, requestId);
      await dismissQwenModals(page);
    } catch (err) {
      yield { type: 'error', message: `Qwen provider error: ${(err as Error).message}` };
    }
  }
}

async function loadQwenModels(page: Page): Promise<ModelInfo[]> {
  const liveModels = await page.evaluate(async () => {
    const token = localStorage.getItem('token') || '';
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      source: 'web',
      version: '0.2.64',
      timezone: new Date().toUTCString(),
      'x-request-id': crypto.randomUUID(),
    };
    if (token) headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;

    const res = await fetch('/api/v2/models/', {
      headers,
      credentials: 'include',
    });
    const json = await res.json();
    return (json?.data?.data || []).map((model: any) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.info?.meta?.max_context_length || model.info?.meta?.max_length,
      maxOutput:
        model.info?.meta?.max_generation_length ||
        model.info?.meta?.max_thinking_generation_length ||
        model.info?.meta?.max_output_length,
      chatType: model.info?.meta?.chat_type || [],
      modality: model.info?.meta?.modality || [],
    }));
  });

  const mapped = liveModels
    .filter((model: any) => typeof model.id === 'string' && model.id.length > 0)
    .filter((model: any) => {
      const chatType = Array.isArray(model.chatType) ? model.chatType : [];
      const modality = Array.isArray(model.modality) ? model.modality : [];
      return chatType.includes('t2t') || modality.includes('text');
    })
    .map((model: any): ModelInfo => ({
      id: resolveQwenModel(model.id),
      name: typeof model.name === 'string' && model.name ? model.name : formatQwenModelName(model.id),
      contextWindow: Number(model.contextWindow) || QWEN_CONTEXT_WINDOW,
      maxOutput: Number(model.maxOutput) || QWEN_MAX_OUTPUT,
    }));

  return mergeQwenModels(mapped, QWEN_KNOWN_MODELS);
}

function mergeQwenModels(primary: ModelInfo[], fallback: ModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const model of [...primary, ...fallback]) {
    if (!byId.has(model.id)) byId.set(model.id, model);
  }
  return [...byId.values()];
}

function resolveQwenModel(modelId: string | undefined): string {
  if (!modelId) return QWEN_DEFAULT_MODEL;
  const normalized = modelId.trim();
  return QWEN_MODEL_ALIASES[normalized] || normalized.replace(/^qwen3-(\d+)/, 'qwen3.$1');
}

function formatQwenModelName(modelId: string): string {
  return modelId
    .replace(/^qwen/i, 'Qwen')
    .replace(/(\d)\.(\d)/, '$1.$2')
    .replace(/-/g, ' ');
}

async function selectQwenModel(page: Page, modelName: string): Promise<void> {
  // Set the target model on window so the fetch interceptor patches the request payload
  await page.evaluate((model) => {
    (window as any).__qwenTargetModel = model;
  }, modelName).catch(() => {});
}

async function dismissQwenModals(page: Page): Promise<void> {
  // 1. Press Escape to close any dialogs or dropdowns
  await page.keyboard.press('Escape').catch(() => {});

  // 2. Click any visible close buttons
  try {
    const closeBtns = page.locator('.ant-modal-close, button[aria-label="Close"], .ant-modal-close-x');
    const count = await closeBtns.count();
    for (let i = 0; i < count; i++) {
      const btn = closeBtns.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 500 }).catch(() => {});
      }
    }
  } catch {}

  // 3. Remove blocking modal overlays directly from DOM
  try {
    await page.evaluate(() => {
      document.querySelectorAll('.ant-modal-wrap, .ant-modal-mask, [role="dialog"], .ant-dropdown').forEach((el) => {
        const text = el.textContent || '';
        if (
          text.includes('Log in') ||
          text.includes('Sign up') ||
          text.includes('Welcome') ||
          el.classList.contains('ant-modal-mask') ||
          el.classList.contains('ant-modal-wrap')
        ) {
          el.remove();
        }
      });
    });
  } catch {}
}

async function fillQwenInput(page: Page, prompt: string): Promise<void> {
  // Always dismiss any modal overlays first
  await dismissQwenModals(page);

  // If textarea is not attached, navigate back to base URL for a fresh chat session
  const taLocator = page.locator('textarea.message-input-textarea').first();
  const hasTa = await taLocator.waitFor({ state: 'attached', timeout: 5000 }).then(() => true).catch(() => false);

  if (!hasTa) {
    console.log('[Qwen] Textarea not found in current page, navigating to root...');
    await page.goto(QWEN_WEB_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await dismissQwenModals(page);
  }

  await dismissQwenModals(page);

  // Strategy 1: Fill via Playwright locator
  const candidates = [
    page.locator('textarea.message-input-textarea').first(),
    page.locator('textarea[placeholder*="Qwen"]').first(),
    page.getByPlaceholder(/Ask anything|Message|Qwen|Send|О чём|С чего/i).first(),
    page.locator('textarea').first(),
    page.locator('[contenteditable="true"]').first(),
    page.locator('.ql-editor').first(),
  ];

  for (const locator of candidates) {
    try {
      if (await locator.isVisible({ timeout: 1500 }).catch(() => false)) {
        await locator.click({ timeout: 3000 }).catch(async () => {
          await dismissQwenModals(page);
          await locator.click({ timeout: 2000 });
        });
        await locator.fill(prompt, { timeout: 3000 }).catch(async () => {
          await locator.pressSequentially(prompt, { timeout: 10000 });
        });
        return;
      }
    } catch {
      await dismissQwenModals(page);
    }
  }

  // Strategy 2: Direct fill via JavaScript dispatch
  const filledViaJs = await page.evaluate((val) => {
    const ta = (
      document.querySelector('textarea.message-input-textarea') ||
      document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"]')
    ) as any;
    if (ta) {
      ta.focus();
      if (ta.value !== undefined) {
        ta.value = val;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        ta.textContent = val;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    }
    return false;
  }, prompt).catch(() => false);

  if (filledViaJs) return;

  throw new Error('Qwen input not found');
}

async function installQwenFetchInterceptor(page: Page, requestId: string, modelName: string): Promise<void> {
  await page.evaluate(({ id, targetModel }) => {
    const win = window as any;
    win.__qwenRequests = win.__qwenRequests || {};
    win.__qwenRequests[id] = {
      chunks: [],
      thoughts: [],
      thoughtSet: {},
      complete: false,
      error: null,
      finishReason: 'stop',
      active: true,
      model: targetModel,
    };

    win.__qwenTargetModel = targetModel;
    if (win.__qwenFetchIntercepted) return;
    win.__qwenFetchIntercepted = true;
    const originalFetch = window.fetch;
    window.fetch = async function (...args: Parameters<typeof fetch>) {
      const url = String((args[0] as any)?.url || args[0] || '');
      let patchedArgs = args;
      if (
        win.__qwenTargetModel &&
        url.includes('/api/v2/') &&
        (url.includes('/api/v2/chats/new') || url.includes('/api/v2/chat/completions'))
      ) {
        const init = { ...(args[1] || {}) } as RequestInit;
        if (typeof init.body === 'string') {
          try {
            const payload = JSON.parse(init.body);
            payload.model = win.__qwenTargetModel;
            if (Array.isArray(payload.models)) payload.models = [win.__qwenTargetModel];
            if (payload.chat && typeof payload.chat === 'object') {
              payload.chat.model = win.__qwenTargetModel;
              if (Array.isArray(payload.chat.models)) payload.chat.models = [win.__qwenTargetModel];
            }
            if (Array.isArray(payload.messages)) {
              for (const message of payload.messages) {
                if (message && typeof message === 'object' && Array.isArray(message.models)) {
                  message.models = [win.__qwenTargetModel];
                }
              }
            }
            init.body = JSON.stringify(payload);
            patchedArgs = [args[0], init] as Parameters<typeof fetch>;
          } catch {
            patchedArgs = args;
          }
        }
      }
      const response = await originalFetch.apply(this, patchedArgs);
      const isChatCompletion =
        url.includes('/api/v2/chat/completions') ||
        url.includes('/api/v2/chats/new') ||
        url.includes('/api/v2/chats');
      if (!isChatCompletion) return response;

      const activeId = Object.keys(win.__qwenRequests || {})
        .find((key) => win.__qwenRequests[key]?.active);
      if (!activeId) return response;

      const request = win.__qwenRequests[activeId];
      try {
        const clone = response.clone();
        const reader = clone.body?.getReader();
        if (!reader) return response;
        const decoder = new TextDecoder();
        let buffered = '';

        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                request.complete = true;
                break;
              }
              buffered += decoder.decode(value, { stream: true });
              const lines = buffered.split('\n');
              buffered = lines.pop() || '';
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (!data || data === '[DONE]') {
                  request.complete = true;
                  continue;
                }
                try {
                  const parsed = JSON.parse(data);
                  const choice = parsed.choices?.[0];
                  const delta = choice?.delta;
                  if (choice?.finish_reason) {
                    request.finishReason = choice.finish_reason;
                    request.complete = true;
                  }
                  if (delta?.phase === 'thinking_summary') {
                    const thoughts = delta.extra?.summary_thought?.content;
                    if (Array.isArray(thoughts)) {
                      for (const thought of thoughts) {
                        if (typeof thought === 'string' && thought && !request.thoughtSet[thought]) {
                          request.thoughtSet[thought] = true;
                          request.thoughts.push(thought);
                        }
                      }
                    }
                  }
                  const reasoning = delta?.reasoning_content || delta?.thinking_content || delta?.reasoning;
                  if (typeof reasoning === 'string' && reasoning && !request.thoughtSet[reasoning]) {
                    request.thoughtSet[reasoning] = true;
                    request.thoughts.push(reasoning);
                  }
                  const content = delta?.content || choice?.text || delta?.text;
                  if (typeof content === 'string' && content) {
                    request.chunks.push(content);
                  }
                } catch {
                  // Ignore non-JSON SSE payloads.
                }
              }
            }
          } catch (err: any) {
            request.error = err?.message || String(err);
            request.complete = true;
          }
        })();
      } catch (err: any) {
        request.error = err?.message || String(err);
        request.complete = true;
      }

      return response;
    };
  }, { id: requestId, targetModel: modelName });
}

async function readQwenCapturedResponse(page: Page, requestId: string): Promise<{
  chunks: string[];
  thoughts: string[];
  complete: boolean;
  error: string | null;
  finishReason: string;
}> {
  return page.evaluate((id) => {
    const req = (window as any).__qwenRequests?.[id];
    return {
      chunks: req?.chunks || [],
      thoughts: req?.thoughts || [],
      complete: Boolean(req?.complete),
      error: req?.error || null,
      finishReason: req?.finishReason || 'stop',
    };
  }, requestId);
}

async function cleanupQwenCapturedResponse(page: Page, requestId: string): Promise<void> {
  await page.evaluate((id) => {
    const req = (window as any).__qwenRequests?.[id];
    if (req) req.active = false;
    setTimeout(() => {
      if ((window as any).__qwenRequests) delete (window as any).__qwenRequests[id];
    }, 5000);
  }, requestId).catch(() => {});
}
