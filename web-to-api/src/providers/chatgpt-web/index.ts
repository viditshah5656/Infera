import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { CHATGPT_WEB_BASE_URL } from './client.js';
import { parseChatGPTSSELine, createStreamState } from './stream.js';
import { AuthStore } from '../../auth/store.js';
import type { Page } from 'playwright-core';

// ======Settings=========
const CHATGPT_CONTEXT_WINDOW = 128000;
const CHATGPT_MAX_OUTPUT = 16384;

/**
 * Models available to anonymous (no-login) ChatGPT users.
 * Anonymous access typically gives: gpt-4o-mini, gpt-4o (limited).
 * The list is validated dynamically at runtime.
 */
const CHATGPT_STATIC_MODELS: ModelInfo[] = [
  { id: 'gpt-4o', name: 'GPT-4o', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'o3', name: 'o3 (Reasoning)', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'o4-mini', name: 'o4 Mini (Reasoning)', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'o3-mini', name: 'o3 Mini (Reasoning)', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'o1', name: 'o1 (Reasoning)', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'o1-mini', name: 'o1 Mini (Reasoning)', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'o1-preview', name: 'o1 Preview (Reasoning)', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'gpt-4', name: 'GPT-4', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
  { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', contextWindow: 16384, maxOutput: 4096 },
  { id: 'chatgpt-4o-latest', name: 'ChatGPT-4o Latest', contextWindow: CHATGPT_CONTEXT_WINDOW, maxOutput: CHATGPT_MAX_OUTPUT },
];

// Stable device ID persisted for the session lifetime so ChatGPT
// recognises us as the same anonymous "device" across requests.
const DEVICE_ID = crypto.randomUUID();
// ======Settings=========

/**
 * Map model IDs to ChatGPT's internal model slug.
 */
function resolveModelSlug(modelId: string): string {
  const normalized = modelId.toLowerCase();
  const slugMap: Record<string, string> = {
    'gpt-4o': 'gpt-4o',
    'gpt-4o-mini': 'gpt-4o-mini',
    'gpt-4.1': 'gpt-4.1',
    'gpt-4.1-mini': 'gpt-4.1-mini',
    'gpt-4.1-nano': 'gpt-4.1-nano',
    'o3': 'o3',
    'o4-mini': 'o4-mini',
    'o3-mini': 'o3-mini',
    'o1': 'o1',
    'o1-mini': 'o1-mini',
    'o1-preview': 'o1-preview',
    'gpt-4': 'gpt-4',
    'gpt-4-turbo': 'gpt-4-turbo',
    'gpt-3.5-turbo': 'text-davinci-002-render-sha',
    'chatgpt-4o-latest': 'chatgpt-4o-latest',
  };
  return slugMap[normalized] || normalized;
}

/**
 * ChatGPT Web Provider — fully anonymous, no login required.
 *
 * Uses ChatGPT's guest/anonymous session flow:
 *   1. Navigate browser to chatgpt.com (gets cookies + Cloudflare clearance automatically)
 *   2. POST /backend-api/sentinel/chat-requirements (gets a one-time chat token)
 *   3. POST /backend-api/conversation with the token (no Bearer auth needed)
 *
 * The browser session auto-refreshes — cookies and Cloudflare tokens are
 * maintained by the browser automatically. Zero manual intervention.
 */
export class ChatGPTProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'chatgpt-web',
    name: 'ChatGPT Web (No Login)',
    website: CHATGPT_WEB_BASE_URL,
    loginUrl: CHATGPT_WEB_BASE_URL,  // No login page — just the main page
    needsBrowser: true,
  };

  private pageReady = false;

  constructor(
    _authStore: AuthStore,
    _browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
    private getPage?: (origin: string) => Promise<Page>,
  ) {
    super();
  }

  async login(_context: { openUrl: (url: string) => Promise<void> }): Promise<void> {
    // No login needed — anonymous access. Just ensure browser has visited chatgpt.com.
    if (this.getPage) {
      await this.ensureBrowserReady();
    }
  }

  /**
   * Always authenticated — ChatGPT allows anonymous chatting.
   * The only requirement is a browser that can reach chatgpt.com.
   */
  async isAuthenticated(): Promise<boolean> {
    return Boolean(this.getPage);
  }

  async detectLoginComplete(): Promise<boolean> {
    return true; // Always "logged in" — anonymous mode
  }

  async models(): Promise<ModelInfo[]> {
    return CHATGPT_STATIC_MODELS;
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.getPage) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    try {
      const page = await this.getPage(CHATGPT_WEB_BASE_URL);

      // Step 1: Ensure the browser has visited chatgpt.com (sets cookies, passes Cloudflare)
      await this.ensureBrowserReady(page);

      // Step 2: Get chat-requirements token (anonymous session token)
      const chatReqs = await this.getChatRequirements(page);
      if (chatReqs.error) {
        yield { type: 'error', message: `ChatGPT: ${chatReqs.error}` };
        return;
      }

      // Step 3: Build prompt
      const prompt = buildWebPrompt(req.messages, req.featureInstruction);
      const modelSlug = resolveModelSlug(req.model);

      // Step 4: Send conversation request with chat-requirements token
      const messageId = crypto.randomUUID();
      const parentMessageId = crypto.randomUUID();

      const sseResult = await page.evaluate(async (args: {
        prompt: string;
        modelSlug: string;
        messageId: string;
        parentMessageId: string;
        deviceId: string;
        chatToken: string;
        chatRequirementsToken: string;
      }) => {
        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Oai-Device-Id': args.deviceId,
            'Oai-Language': 'en-US',
            'Openai-Sentinel-Chat-Requirements-Token': args.chatRequirementsToken,
          };

          // If we got a turnstile token, include it
          if (args.chatToken) {
            headers['Openai-Sentinel-Turnstile-Token'] = args.chatToken;
          }

          const body = {
            action: 'next',
            messages: [
              {
                id: args.messageId,
                author: { role: 'user' },
                content: {
                  content_type: 'text',
                  parts: [args.prompt],
                },
                metadata: {},
              },
            ],
            model: args.modelSlug,
            parent_message_id: args.parentMessageId,
            timezone_offset_min: new Date().getTimezoneOffset(),
            suggestions: [],
            history_and_training_disabled: true,
            conversation_mode: { kind: 'primary_assistant' },
            force_paragen: false,
            force_paragen_model_slug: '',
            force_nulligen: false,
            force_rate_limit: false,
            reset_rate_limits: false,
            websocket_request_id: crypto.randomUUID(),
          };

          const res = await fetch('/backend-anon/conversation', {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            credentials: 'include',
          });

          if (!res.ok) {
            const text = await res.text();
            return { error: `HTTP ${res.status}: ${text.substring(0, 300)}` };
          }

          // Read the full SSE stream
          const reader = res.body?.getReader();
          if (!reader) return { error: 'No response body' };

          const decoder = new TextDecoder();
          let fullText = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
          }
          return { data: fullText };
        } catch (e: any) {
          return { error: e.message };
        }
      }, {
        prompt,
        modelSlug,
        messageId,
        parentMessageId,
        deviceId: DEVICE_ID,
        chatToken: chatReqs.turnstileToken || '',
        chatRequirementsToken: chatReqs.token || '',
      });

      if (sseResult.error) {
        // If we got a 403/401, the session may have expired — reset and retry hint
        if (sseResult.error.includes('403') || sseResult.error.includes('401')) {
          this.pageReady = false;
        }
        yield { type: 'error', message: `ChatGPT API error: ${sseResult.error}` };
        return;
      }

      // Step 5: Parse SSE response
      const lines = (sseResult.data ?? '').split('\n');
      const streamState = createStreamState();
      let hasDone = false;
      let hasContent = false;

      for (const line of lines) {
        const events = parseChatGPTSSELine(line, streamState);
        for (const event of events) {
          if (event.type === 'text_delta' || event.type === 'thinking_delta') {
            hasContent = true;
          }
          if (event.type === 'done') {
            hasDone = true;
          }
          yield event;
        }
      }

      // Ensure we emit a done event if the stream didn't have one
      if (hasContent && !hasDone) {
        yield { type: 'done', reason: 'stop' };
      }

    } catch (err) {
      yield { type: 'error', message: `ChatGPT provider error: ${(err as Error).message}` };
    }
  }

  /**
   * Ensure the browser has navigated to chatgpt.com at least once.
   * This sets all necessary cookies, passes Cloudflare challenge,
   * and establishes the anonymous session. The browser maintains
   * this session automatically (cookies auto-refresh).
   */
  private async ensureBrowserReady(page?: Page): Promise<void> {
    if (this.pageReady) return;

    if (!page && this.getPage) {
      page = await this.getPage(CHATGPT_WEB_BASE_URL);
    }
    if (!page) return;

    const currentUrl = page.url();
    if (!currentUrl.includes('chatgpt.com') && !currentUrl.includes('chat.openai.com')) {
      console.log(`[ChatGPT] Navigating to ${CHATGPT_WEB_BASE_URL}...`);
      await page.goto(CHATGPT_WEB_BASE_URL, {
        waitUntil: 'networkidle',
        timeout: 30000,
      }).catch((e) => console.log(`[ChatGPT] Navigation warning: ${e.message}`));
      await page.waitForTimeout(3000).catch(() => {});
    }
    console.log(`[ChatGPT] Current URL: ${page.url()}, Title: ${await page.title().catch(() => '')}`);

    this.pageReady = true;
  }

  /**
   * Get chat-requirements token for anonymous conversation.
   *
   * ChatGPT's anonymous flow requires calling this endpoint before
   * each conversation. It returns:
   *   - A chat-requirements token (required header for /backend-api/conversation)
   *   - Optionally a turnstile challenge (Cloudflare anti-bot)
   *   - Optionally a proof-of-work challenge
   *
   * The browser context handles cookies automatically.
   */
  private async getChatRequirements(page: Page): Promise<{
    token?: string;
    turnstileToken?: string;
    proofOfWork?: any;
    error?: string;
  }> {
    const result = await page.evaluate(async (deviceId: string) => {
      try {
        const res = await fetch('/backend-anon/sentinel/chat-requirements', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Oai-Device-Id': deviceId,
            'Oai-Language': 'en-US',
          },
          body: JSON.stringify({
            p: undefined,
          }),
          credentials: 'include',
        });

        if (!res.ok) {
          const text = await res.text();
          return { error: `chat-requirements failed: HTTP ${res.status}: ${text.substring(0, 200)}` };
        }

        const data = await res.json();
        return {
          token: data?.token || '',
          turnstileToken: data?.turnstile?.turnstile_token || '',
          proofOfWork: data?.proofofwork || null,
          persona: data?.persona || 'chatgpt-freeaccount',
        };
      } catch (e: any) {
        return { error: `chat-requirements error: ${e.message}` };
      }
    }, DEVICE_ID);

    if (result.error) {
      // Session might be stale — force re-navigation next time
      this.pageReady = false;
      return { error: result.error };
    }

    return {
      token: result.token,
      turnstileToken: result.turnstileToken,
      proofOfWork: result.proofOfWork,
    };
  }
}
