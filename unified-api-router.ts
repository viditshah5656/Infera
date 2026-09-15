#!/usr/bin/env node
/**
 * Unified API Router — Universal Web2API Gateway
 *
 * Supports:
 *   - Google Gemini Web2API (11 models, 20k token auto-continue)
 *   - Alibaba Qwen Cloud via qwen2api (dynamic discovery, thinking, image generation)
 *   - OpenAI ChatGPT without login (gpt-4o, gpt-4o-mini, gpt-4.1, o3, o4-mini, o1, etc.)
 *   - Anthropic Claude Messages API (/v1/messages) for Claude Code CLI & agentic coding
 *   - OpenAI Responses API (/v1/responses) for Codex CLI
 *   - OpenAI Chat Completions (/v1/chat/completions)
 *   - Image Generation (/v1/images/generations)
 *
 * Zero API keys required. All models run through reverse-engineered web backends.
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = parseInt(process.env.UNIFIED_PORT?.trim() || "8081", 10);
const HOST = process.env.UNIFIED_HOST?.trim() || "127.0.0.1";

// Backend URLs
const GEMINI_BACKEND = process.env.GEMINI_BACKEND?.trim() || "http://127.0.0.1:8082";
const QWEN2API_BACKEND = process.env.QWEN2API_BACKEND?.trim() || "http://127.0.0.1:8765";
const CHATGPT_BACKEND = process.env.CHATGPT_BACKEND?.trim() || "http://127.0.0.1:5000";
const QWEN_API_TOKEN = process.env.QWEN_API_TOKEN?.trim();
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 100 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 100 });

// How often to refresh the Qwen model list (ms)
const QWEN_MODEL_REFRESH_MS = 10 * 60 * 1000; // 10 minutes
const CHATGPT_MODEL_REFRESH_MS = 10 * 60 * 1000; // 10 minutes

const CHAT_PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "share", "chat.html");
const SHARE_PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "share", "index.html");

// ─── Models ──────────────────────────────────────────────────────────────────

const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.8-flash-thinking",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-thinking",
  "gemini-3.1-pro",
  "gemini-auto",
  "gemini-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

const CHATGPT_MODELS = [
  "auto",
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "o3",
  "o4-mini",
  "o3-mini",
  "o1",
  "o1-mini",
  "o1-preview",
  "gpt-4",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
  "chatgpt-4o-latest",
];

// ─── Dynamic Qwen Models (fetched from qwen2api) ────────────────────────────

interface QwenModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

let qwenModels: string[] = [];
let qwenModelsFetchedAt = 0;
let qwenModelsFetching = false;
let chatgptModels: string[] = [];
let chatgptModelsFetchedAt = 0;
let chatgptModelsFetching = false;
let chatgptBackendReady = false;
let chatgptBackendError: string | null = null;

async function fetchQwenModels(): Promise<string[]> {
  const url = `${QWEN2API_BACKEND}/v1/models`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "Accept": "application/json" },
    });
    if (!resp.ok) {
      console.error(`[Router] qwen2api /v1/models returned HTTP ${resp.status}`);
      return qwenModels.length > 0 ? qwenModels : getQwenFallbackModels();
    }
    const data = await resp.json() as { object: string; data: QwenModelEntry[] };
    const ids = (data.data || [])
      .map((m) => m.id)
      .filter((id) => typeof id === "string" && id.length > 0);
    if (ids.length === 0) {
      return qwenModels.length > 0 ? qwenModels : getQwenFallbackModels();
    }
    return Array.from(new Set(ids));
  } catch (err: any) {
    return qwenModels.length > 0 ? qwenModels : getQwenFallbackModels();
  }
}

function getQwenFallbackModels(): string[] {
  return [
    "qwen3.8-max",
    "qwen3.7-plus",
    "qwen3.7-max",
    "qwen3.6-plus",
    "qwen-plus",
    "qwen-max",
    "qwen-turbo",
    "qwq-32b",
  ];
}

function getChatGPTFallbackModels(): string[] {
  return [...CHATGPT_MODELS];
}

async function fetchChatGPTModels(): Promise<string[]> {
  try {
    const resp = await fetch(`${CHATGPT_BACKEND}/v1/models`, {
      signal: AbortSignal.timeout(8000),
      headers: { "Accept": "application/json" },
    });
    if (!resp.ok) {
      chatgptBackendReady = false;
      chatgptBackendError = `HTTP ${resp.status}`;
      return chatgptModels.length > 0 ? chatgptModels : getChatGPTFallbackModels();
    }
    const data = await resp.json() as { data?: Array<{ id?: unknown }> };
    const ids = (data.data || [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) {
      chatgptBackendReady = false;
      chatgptBackendError = "Backend returned no models";
      return chatgptModels.length > 0 ? chatgptModels : getChatGPTFallbackModels();
    }
    chatgptBackendReady = true;
    chatgptBackendError = null;
    return Array.from(new Set(ids));
  } catch (error: any) {
    chatgptBackendReady = false;
    chatgptBackendError = error?.message || String(error);
    return chatgptModels.length > 0 ? chatgptModels : getChatGPTFallbackModels();
  }
}

async function refreshQwenModelsIfNeeded(): Promise<void> {
  const now = Date.now();
  if (qwenModelsFetching || (now - qwenModelsFetchedAt < QWEN_MODEL_REFRESH_MS)) {
    return;
  }
  qwenModelsFetching = true;
  try {
    const models = await fetchQwenModels();
    qwenModels = models;
    qwenModelsFetchedAt = Date.now();
    console.log(`[Router] Qwen models refreshed: ${models.length} models ready`);
  } catch (err: any) {
    console.error(`[Router] Qwen model refresh failed: ${err.message}`);
  } finally {
    qwenModelsFetching = false;
  }
}

async function refreshChatGPTModelsIfNeeded(): Promise<void> {
  const now = Date.now();
  if (chatgptModelsFetching || (now - chatgptModelsFetchedAt < CHATGPT_MODEL_REFRESH_MS)) {
    return;
  }
  chatgptModelsFetching = true;
  try {
    const models = await fetchChatGPTModels();
    chatgptModels = models;
    chatgptModelsFetchedAt = Date.now();
    console.log(`[Router] ChatGPT models refreshed: ${models.length} models ready`);
  } finally {
    chatgptModelsFetching = false;
  }
}

function isQwenModel(model: string): boolean {
  const normalized = (model || "").toLowerCase().trim();
  if (qwenModels.some((m) => m.toLowerCase() === normalized)) return true;
  return /^qwe?n|^qwq/i.test(normalized);
}

function isChatGPTModel(model: string): boolean {
  const normalized = (model || "").toLowerCase().trim();
  if (chatgptModels.some((m) => m.toLowerCase() === normalized)) return true;
  if (CHATGPT_MODELS.some((m) => m.toLowerCase() === normalized)) return true;
  // Keep GPT aliases on the ChatGPT backend even when its /v1/models
  // endpoint is temporarily unavailable during router startup.
  return /^(?:gpt-|o[134](?:-|$)|chatgpt-)/i.test(normalized);
}

function getBackendUrl(model: string): string {
  const normalized = (model || "").toLowerCase().trim();

  // Qwen models -> qwen2api (port 8765)
  if (isQwenModel(normalized)) {
    return QWEN2API_BACKEND;
  }

  // ChatGPT models normally use the web backend. When that anonymous session
  // is blocked, Gemini is the reliable local fallback for Codex Responses.
  if (isChatGPTModel(normalized)) {
    if (process.env.CHATGPT_BACKEND_DISABLED === "1") return GEMINI_BACKEND;
    return CHATGPT_BACKEND;
  }

  // Default to Gemini backend (port 8082, pure zero-auth stream with 20k token auto-continue)
  return GEMINI_BACKEND;
}

function getAllModels(): string[] {
  return [...new Set([...GEMINI_MODELS, ...qwenModels, ...chatgptModels])];
}

// ─── Proxy Request ───────────────────────────────────────────────────────────

function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  backendUrl: string,
  body?: string
): void {
  const method = req.method || "GET";
  const upstreamPath = req.url || "/";
  const urlObj = new URL(backendUrl);

  const forwardedHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
  delete forwardedHeaders.host;
  delete forwardedHeaders.authorization;
  delete forwardedHeaders["x-api-key"];
  delete forwardedHeaders.cookie;

  if (backendUrl === QWEN2API_BACKEND && QWEN_API_TOKEN) {
    forwardedHeaders.authorization = `Bearer ${QWEN_API_TOKEN}`;
  }

  if (backendUrl === QWEN2API_BACKEND && QWEN_API_TOKEN) {
    forwardedHeaders.authorization = `Bearer ${QWEN_API_TOKEN}`;
  }

  if (body !== undefined) {
    delete forwardedHeaders["content-length"];
    delete forwardedHeaders["transfer-encoding"];
    forwardedHeaders["content-length"] = Buffer.byteLength(body).toString();
  }

  const options: http.RequestOptions = {
    hostname: urlObj.hostname,
    port: urlObj.port || (backendUrl.startsWith("https:") ? 443 : 80),
    path: upstreamPath,
    method,
    headers: forwardedHeaders,
    agent: urlObj.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT,
  };

  const request = urlObj.protocol === "https:" ? https.request : http.request;
  const proxyReq = request(options, (proxyRes) => {
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    proxyRes.on("data", (chunk) => {
      res.write(chunk);
    });

    proxyRes.on("end", () => {
      res.end();
    });
  });

  proxyReq.on("error", (err) => {
    console.error(`[Router] Proxy error to ${backendUrl}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `Backend ${backendUrl} unavailable (${err.message}). Ensure services are running.`,
            type: "server_error",
            code: "backend_unavailable",
          },
        })
      );
    } else {
      try { res.end(); } catch {}
    }
  });

  if (body !== undefined) {
    proxyReq.end(body);
  } else {
    req.pipe(proxyReq);
  }
}

function proxyRequestToPath(
  req: IncomingMessage,
  res: ServerResponse,
  backendUrl: string,
  upstreamPath: string,
  body?: string
): void {
  const method = req.method || "GET";
  const urlObj = new URL(backendUrl);

  const forwardedHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
  delete forwardedHeaders.host;
  delete forwardedHeaders.authorization;
  delete forwardedHeaders["x-api-key"];
  delete forwardedHeaders.cookie;

  if (body !== undefined) {
    delete forwardedHeaders["content-length"];
    delete forwardedHeaders["transfer-encoding"];
    forwardedHeaders["content-length"] = Buffer.byteLength(body).toString();
  }

  const options: http.RequestOptions = {
    hostname: urlObj.hostname,
    port: urlObj.port || (backendUrl.startsWith("https:") ? 443 : 80),
    path: upstreamPath,
    method,
    headers: forwardedHeaders,
    agent: urlObj.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT,
  };

  const request = urlObj.protocol === "https:" ? https.request : http.request;
  const proxyReq = request(options, (proxyRes) => {
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");

    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }

    proxyRes.on("data", (chunk) => {
      res.write(chunk);
    });

    proxyRes.on("end", () => {
      res.end();
    });
  });

  proxyReq.on("error", (err) => {
    console.error(`[Router] Proxy error to ${backendUrl}${upstreamPath}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `Backend ${backendUrl} unavailable (${err.message})`,
            type: "server_error",
            code: "backend_unavailable",
          },
        })
      );
    } else {
      try { res.end(); } catch {}
    }
  });

  if (body !== undefined) {
    proxyReq.end(body);
  } else {
    req.pipe(proxyReq);
  }
}

// ─── Anthropic Claude Messages API (/v1/messages) ───────────────────────────

async function handleClaudeMessages(req: IncomingMessage, res: ServerResponse, body: any): Promise<void> {
  const model = body.model || "claude-3-7-sonnet";
  const stream = Boolean(body.stream);
  const maxTokens = body.max_tokens || 20000;
  const systemPrompt = typeof body.system === "string" ? body.system : "";
  const anthropicMessages = Array.isArray(body.messages) ? body.messages : [];

  // Convert Anthropic messages to OpenAI format
  const openAiMessages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    openAiMessages.push({ role: "system", content: systemPrompt });
  }

  for (const msg of anthropicMessages) {
    const role = msg.role === "assistant" ? "assistant" : "user";
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .map((c: any) => {
          if (c.type === "text" && typeof c.text === "string") return c.text;
          if (c.type === "tool_result") {
            const result = typeof c.content === "string"
              ? c.content
              : JSON.stringify(c.content ?? "");
            return `[Tool result ${c.tool_use_id || ""}]\n${result}`;
          }
          if (c.type === "tool_use") {
            return `[Tool call ${c.name || ""}]\n${JSON.stringify(c.input ?? {})}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    openAiMessages.push({ role, content: text });
  }

  // Choose the best reasoning backend for Claude requests
  let mappedModel = "gemini-3.8-flash-thinking";
  if (model.includes("haiku")) {
    mappedModel = "gemini-3.8-flash";
  } else if (model.includes("opus") || model.includes("sonnet")) {
    mappedModel = "gemini-3.8-flash-thinking";
  }

  const completionPayload = {
    model: mappedModel,
    messages: openAiMessages,
    stream,
    max_tokens: maxTokens,
  };

  const backendUrl = GEMINI_BACKEND;
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.writeHead(200);

    // 1. message_start
    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 }
      }
    })}\n\n`);

    // 2. content_block_start
    res.write(`event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    })}\n\n`);

    const urlObj = new URL(backendUrl);
    const options: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      let buffer = "";
      let outputTokens = 0;

      proxyRes.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        while (buffer.includes("\n")) {
          const lineEnd = buffer.indexOf("\n");
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);

          if (!line.startsWith("data: ")) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === "[DONE]") continue;

          try {
            const data = JSON.parse(dataStr);
            const deltaContent = data.choices?.[0]?.delta?.content || "";
            if (deltaContent) {
              outputTokens += Math.ceil(deltaContent.length / 4);
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: deltaContent }
              })}\n\n`);
            }
          } catch {}
        }
      });

      proxyRes.on("end", () => {
        // 3. content_block_stop
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: 0
        })}\n\n`);

        // 4. message_delta
        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: Math.max(1, outputTokens) }
        })}\n\n`);

        // 5. message_stop
        res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        res.end();
      });
    });

    proxyReq.on("error", (err) => {
      console.error("[Router] Claude stream proxy error:", err.message);
      res.end();
    });

    proxyReq.end(JSON.stringify(completionPayload));
  } else {
    // Non-streaming
    try {
      const resp = await fetch(`${backendUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(completionPayload),
      });
      const data = await resp.json() as any;
      const contentText = data?.choices?.[0]?.message?.content || "";

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({
        id: msgId,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: contentText }],
        model,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: Math.max(1, Math.ceil(contentText.length / 4)),
        },
      }));
    } catch (err: any) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "api_error", message: err.message } }));
    }
  }
}

// ─── Responses API orchestration ─────────────────────────────────────────────

type StoredResponse = {
  messages: any[];
  createdAt: number;
  sessionId: string;
  model: string;
};

const responseStore = new Map<string, StoredResponse>();
const RESPONSE_STORE_TTL_MS = 24 * 60 * 60 * 1000;
const RESPONSE_STORE_MAX = 5000;
const RESPONSE_JOURNAL = process.env.MEERA_RESPONSE_JOURNAL?.trim() || path.join(path.dirname(fileURLToPath(import.meta.url)), "meera_response_journal.jsonl");

function getOrCreateSessionId(body: any, previous?: StoredResponse): string {
  const supplied = typeof body?.metadata?.meera_session_id === "string" ? body.metadata.meera_session_id.trim() : "";
  if (supplied) return supplied;
  if (previous?.sessionId) return previous.sessionId;
  return `meera_${crypto.randomUUID().replace(/-/g, "")}`;
}

function persistResponse(id: string, value: StoredResponse): void {
  try {
    fs.appendFileSync(RESPONSE_JOURNAL, JSON.stringify({ id, ...value }) + "\n", "utf8");
  } catch (err: any) {
    console.warn(`[Router] Could not persist response ${id}: ${err?.message || err}`);
  }
}

function loadResponseJournal(): void {
  try {
    if (!fs.existsSync(RESPONSE_JOURNAL)) return;
    const raw = fs.readFileSync(RESPONSE_JOURNAL, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row?.id && Array.isArray(row.messages) && row.sessionId) {
          responseStore.set(row.id, { messages: row.messages, createdAt: row.createdAt || Date.now(), sessionId: row.sessionId, model: row.model || "" });
        }
      } catch {}
    }
    pruneResponseStore();
    console.log(`[Router] Restored ${responseStore.size} persisted Responses sessions`);
  } catch (err: any) {
    console.warn(`[Router] Response journal restore failed: ${err?.message || err}`);
  }
}

function pruneResponseStore(): void {
  const cutoff = Date.now() - RESPONSE_STORE_TTL_MS;
  for (const [id, value] of responseStore) {
    if (value.createdAt < cutoff) responseStore.delete(id);
  }
  while (responseStore.size > RESPONSE_STORE_MAX) {
    const first = responseStore.keys().next().value;
    if (first) responseStore.delete(first);
    else break;
  }
}

function responseInputToMessages(body: any): any[] {
  const messages: any[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || item.id || "",
          name: item.name,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
        });
        continue;
      }
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: item.call_id || item.id,
            type: "function",
            function: {
              name: item.name,
              arguments: item.arguments
                || (typeof item.input === "string" ? JSON.stringify({ input: item.input }) : JSON.stringify(item.input ?? {})),
            },
          }],
        });
        continue;
      }
      const role = item.role || (item.type === "message" ? "user" : "user");
      const content = Array.isArray(item.content)
        ? item.content
          .filter((part: any) => part?.type === "input_text" || part?.type === "output_text" || part?.type === "text")
          .map((part: any) => part.text || "")
          .join("")
        : (item.content ?? item.text ?? "");
      if (content || role !== "user") messages.push({ role, content });
    }
  }
  return messages;
}

function responseToolsToChatTools(tools: any): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const flattened: any[] = [];

  const addTool = (tool: any, namespace?: string) => {
    if (!tool || typeof tool !== "object") return;

    // Custom Responses providers sometimes receive Codex MCP tools wrapped in
    // a namespace object. Most Chat Completions Web2APIs only understand
    // top-level function tools, so flatten the namespace here.
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      const ns = typeof tool.name === "string" ? tool.name : "";
      for (const child of tool.tools) addTool(child, ns);
      return;
    }

    if (tool.type === "custom" && tool.name) {
      // Freeform/custom Responses tools have no JSON schema. For a generic
      // Chat Completions backend expose them as a function with a single
      // string input so the backend can still produce a structured call.
      const rawName = tool.name;
      flattened.push({
        type: "function",
        function: {
          name: namespace && namespace !== "functions"
            ? `${namespace}__${rawName}`
            : rawName,
          description: tool.description || "",
          parameters: {
            type: "object",
            properties: {
              input: { type: "string" },
            },
            required: ["input"],
          },
        },
      });
      return;
    }

    if (tool.type === "function" && tool.function) {
      const fn = { ...tool.function };
      const rawName = fn.name || tool.name || "";
      fn.name = namespace && namespace !== "functions"
        ? `${namespace}__${rawName}`
        : rawName;
      flattened.push({ type: "function", function: fn });
      return;
    }

    if (tool.type === "function" && tool.name) {
      const rawName = tool.name;
      flattened.push({
        type: "function",
        function: {
          name: namespace && namespace !== "functions"
            ? `${namespace}__${rawName}`
            : rawName,
          description: tool.description || "",
          parameters: tool.parameters || {},
        },
      });
      return;
    }

    if (tool.function && typeof tool.function === "object") {
      const fn = { ...tool.function };
      const rawName = fn.name || tool.name || "";
      fn.name = namespace && namespace !== "functions"
        ? `${namespace}__${rawName}`
        : rawName;
      flattened.push({ type: "function", function: fn });
      return;
    }

    if (tool.name) {
      flattened.push({
        type: "function",
        function: {
          name: namespace && namespace !== "functions"
            ? `${namespace}__${tool.name}`
            : tool.name,
          description: tool.description || "",
          parameters: tool.parameters || {},
        },
      });
    }
  };

  for (const tool of tools) addTool(tool);
  return flattened.length ? flattened : undefined;
}

function chatMessageToResponseOutput(message: any): any[] {
  const output: any[] = [];
  for (const call of message?.tool_calls || []) {
    output.push({
      type: "function_call",
      id: call.id,
      call_id: call.id,
      name: call.function?.name || "",
      arguments: call.function?.arguments || "{}",
      status: "completed",
    });
  }
  const text = message?.content;
  if (typeof text === "string" || output.length === 0) {
    output.push({
      type: "message",
      id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: text || "", annotations: [] }],
    });
  }
  return output;
}

function responseOutputText(output: any[]): string {
  return output
    .filter((item) => item?.type === "message")
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function writeResponseEvent(res: ServerResponse, type: string, sequence: number, fields: any): void {
  const event = { type, sequence_number: sequence, ...fields };
  res.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function buildCanonicalResponseFields(body: any, model: string, responseId: string, createdAt: number, status: string, output: any[], usage: any): any {
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    instructions: typeof body.instructions === "string" ? body.instructions : null,
    max_output_tokens: body.max_output_tokens ?? body.max_tokens ?? null,
    model,
    output,
    parallel_tool_calls: body.parallel_tool_calls !== false,
    previous_response_id: body.previous_response_id || null,
    reasoning: body.reasoning || { effort: null, summary: null },
    store: body.store !== false,
    temperature: body.temperature ?? 1,
    text: body.text || { format: { type: "text" } },
    tool_choice: body.tool_choice || "auto",
    tools: Array.isArray(body.tools) ? body.tools : [],
    top_p: body.top_p ?? 1,
    truncation: body.truncation || "disabled",
    usage: status === "in_progress" ? null : usage,
    user: body.user || null,
    metadata: { ...(body.metadata || {}), meera_session_id: body.metadata?.meera_session_id || null },
  };
}

async function handleResponsesRequest(res: ServerResponse, body: any): Promise<void> {
  pruneResponseStore();

  const model = body.model || "gemini-3.8-flash";
  if (!(isChatGPTModel(model) || isQwenModel(model) || GEMINI_MODELS.includes(model))) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: { type: "invalid_request_error", message: `Unknown model: ${model}` }
    }));
    return;
  }

  const previous = body.previous_response_id
    ? responseStore.get(body.previous_response_id)
    : undefined;
  const sessionId = getOrCreateSessionId(body, previous);

  const messages = [...(previous?.messages || []), ...responseInputToMessages(body)];

  if (!messages.length) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: { type: "invalid_request_error", message: "input is required" }
    }));
    return;
  }

  const wantsStream = Boolean(body.stream);
  const backendUrl = getBackendUrl(model);

  // Codex is a Responses client. Our Web2API backends are mostly
  // Chat-Completions compatible, so the gateway adapts the wire format.
  //
  // IMPORTANT: when Codex asks for streaming, DO NOT wait for the complete
  // upstream response before sending the first SSE frame. Codex has a
  // stream-idle watchdog (currently commonly 300s), and long web generations
  // can otherwise look like a dead connection. We therefore translate the
  // upstream Chat Completions SSE stream into Responses SSE as it arrives.
  const chatBody: any = {
    model,
    messages,
    stream: wantsStream,
    max_tokens: body.max_output_tokens || body.max_tokens,
    tools: responseToolsToChatTools(body.tools),
    tool_choice: body.tool_choice,
    parallel_tool_calls: body.parallel_tool_calls,
    temperature: body.temperature,
    top_p: body.top_p,
    reasoning: body.reasoning,
  };

  Object.keys(chatBody).forEach((key) => {
    if (chatBody[key] === undefined) delete chatBody[key];
  });

  const responseId = `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const baseResponse = {
    id: responseId,
    object: "response",
    created_at: createdAt,
    model,
  };

  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: wantsStream ? "text/event-stream" : "application/json",
    "X-Meera-Session-ID": sessionId,
    "X-Meera-Model": model,
  };

  if (backendUrl === QWEN2API_BACKEND && QWEN_API_TOKEN) {
    requestHeaders.Authorization = `Bearer ${QWEN_API_TOKEN}`;
  }

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${backendUrl}/v1/chat/completions`, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(chatBody),
    });
  } catch (err: any) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        type: "upstream_error",
        message: err?.message || String(err),
      },
    }));
    return;
  }

  // Never silently substitute another model when the user selected GPT.
  // An optional fallback can be enabled explicitly with CHATGPT_ALLOW_MODEL_FALLBACK=1.
  if (!upstream.ok && backendUrl === CHATGPT_BACKEND && process.env.CHATGPT_ALLOW_MODEL_FALLBACK === "1") {
    console.warn(`[Router] ChatGPT backend returned HTTP ${upstream.status}; explicit Gemini fallback enabled`);
    const fallbackBody = { ...chatBody, model: "gemini-3.8-flash" };
    try {
      upstream = await fetch(`${GEMINI_BACKEND}/v1/chat/completions`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(fallbackBody),
      });
    } catch (err: any) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "upstream_error", message: err?.message || String(err) } }));
      return;
    }
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        type: "upstream_error",
        message: detail || `Backend returned HTTP ${upstream.status}`,
      },
    }));
    return;
  }

  // Non-streaming Responses request.
  if (!wantsStream) {
    let completion: any;
    try {
      completion = await upstream.json();
    } catch (err: any) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          type: "upstream_error",
          message: `Invalid upstream JSON: ${err?.message || String(err)}`,
        },
      }));
      return;
    }

    const message = completion?.choices?.[0]?.message || {
      role: "assistant",
      content: "",
    };

    const output = chatMessageToResponseOutput(message);
    const stored = {
      messages: [...messages, message],
      createdAt: Date.now(),
      sessionId,
      model,
    };
    responseStore.set(responseId, stored);
    persistResponse(responseId, stored);

    const usage = {
      input_tokens: completion?.usage?.prompt_tokens || 0,
      input_tokens_details: { cached_tokens: completion?.usage?.prompt_tokens_details?.cached_tokens || 0, cache_write_tokens: completion?.usage?.prompt_tokens_details?.cache_write_tokens || 0 },
      output_tokens: completion?.usage?.completion_tokens || 0,
      output_tokens_details: { reasoning_tokens: completion?.usage?.completion_tokens_details?.reasoning_tokens || 0 },
      total_tokens: completion?.usage?.total_tokens || 0,
    };

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });

    res.end(JSON.stringify({
      ...baseResponse,
      status: output.some((item: any) => item.type === "function_call")
        ? "requires_action"
        : "completed",
      output,
      output_text: responseOutputText(output),
      usage,
    }));
    return;
  }

  // Streaming Responses adapter.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // Codex can declare a stream idle when a web model pauses for a long
  // reasoning/generation interval. Valid SSE comments keep the connection
  // alive without creating fake Responses events.
  const keepAlive = setInterval(() => {
    if (!res.writableEnded) {
      try { res.write(": keep-alive\n\n"); } catch {}
    }
  }, 15000);

  let sequence = 0;
  const output: any[] = [];
  const textParts: string[] = [];
  const toolCalls = new Map<number, {
    id: string;
    call_id: string;
    name: string;
    arguments: string;
  }>();
  let messageId: string | null = null;
  let responseUsage: any = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
  let sawTerminal = false;

  writeResponseEvent(res, "response.created", ++sequence, {
    response: buildCanonicalResponseFields(body, model, responseId, createdAt, "in_progress", [], null),
  });
  writeResponseEvent(res, "response.in_progress", ++sequence, {
    response: buildCanonicalResponseFields(body, model, responseId, createdAt, "in_progress", [], null),
  });

  const decoder = new TextDecoder();
  let buffer = "";

  const processUpstreamEvent = (rawEvent: string) => {
    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (!dataLines.length) return;
    const dataText = dataLines.join("\n").trim();
    if (!dataText || dataText === "[DONE]") {
      // Chat Completions [DONE] is NOT the Responses terminal event.
      // We must still synthesize response.completed below.
      return;
    }

    let chunk: any;
    try {
      chunk = JSON.parse(dataText);
    } catch {
      return;
    }

    // Some compatible backends may send an already-formed Responses event.
    // Pass it through rather than double-wrapping it.
    if (typeof chunk?.type === "string" && chunk.type.startsWith("response.")) {
      if (chunk.type === "response.completed") sawTerminal = true;
      res.write(`event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`);
      return;
    }

    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || {};

    if (chunk?.usage) {
      responseUsage = {
        input_tokens: chunk.usage.prompt_tokens || chunk.usage.input_tokens || 0,
        input_tokens_details: {
          cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens || chunk.usage.input_tokens_details?.cached_tokens || 0,
          cache_write_tokens: chunk.usage.prompt_tokens_details?.cache_write_tokens || chunk.usage.input_tokens_details?.cache_write_tokens || 0,
        },
        output_tokens: chunk.usage.completion_tokens || chunk.usage.output_tokens || 0,
        output_tokens_details: { reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens || chunk.usage.output_tokens_details?.reasoning_tokens || 0 },
        total_tokens: chunk.usage.total_tokens || 0,
      };
    }

    if (typeof delta.content === "string" && delta.content) {
      if (!messageId) {
        messageId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const messageItem = {
          type: "message",
          id: messageId,
          role: "assistant",
          status: "in_progress",
          phase: "final_answer",
          content: [],
        };
        output.push({
          type: "message",
          id: messageId,
          role: "assistant",
          status: "completed",
          phase: "final_answer",
          content: [{ type: "output_text", text: "", annotations: [] }],
        });

        writeResponseEvent(res, "response.output_item.added", ++sequence, {
          output_index: output.length - 1,
          item: messageItem,
        });
        writeResponseEvent(res, "response.content_part.added", ++sequence, {
          item_id: messageId,
          output_index: output.length - 1,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        });
      }

      textParts.push(delta.content);
      const outputIndex = output.findIndex((item) => item.id === messageId);
      writeResponseEvent(res, "response.output_text.delta", ++sequence, {
        item_id: messageId,
        output_index: outputIndex >= 0 ? outputIndex : 0,
        content_index: 0,
        delta: delta.content,
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = Number.isInteger(tc?.index) ? tc.index : toolCalls.size;
        let call = toolCalls.get(index);

        if (!call) {
          const id = tc?.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
          const name = tc?.function?.name || "";
          call = {
            id,
            call_id: id,
            name,
            arguments: "",
          };
          toolCalls.set(index, call);

          const outputIndex = output.length;
          output.push({
            type: "function_call",
            id: call.id,
            call_id: call.call_id,
            name: call.name,
            arguments: "",
            status: "completed",
          });

          writeResponseEvent(res, "response.output_item.added", ++sequence, {
            output_index: outputIndex,
            item: {
              type: "function_call",
              id: call.id,
              call_id: call.call_id,
              name: call.name,
              arguments: "",
              status: "in_progress",
            },
          });
        }

        if (tc?.function?.name && !call.name) {
          call.name = tc.function.name;
          const outputItem = output.find((item) => item.id === call!.id);
          if (outputItem) outputItem.name = call.name;
        }

        const argsDelta = tc?.function?.arguments || "";
        if (argsDelta) {
          call.arguments += argsDelta;
          const outputIndex = output.findIndex((item) => item.id === call!.id);
          const outputItem = output[outputIndex];
          if (outputItem) outputItem.arguments = call.arguments;

          writeResponseEvent(res, "response.function_call_arguments.delta", ++sequence, {
            item_id: call.id,
            output_index: outputIndex,
            delta: argsDelta,
          });
        }
      }
    }
  };

  try {
    if (!upstream.body) {
      throw new Error("Upstream returned no response body for a streaming request.");
    }

    for await (const chunk of upstream.body as any) {
      buffer += decoder.decode(chunk, { stream: true });

      // Upstream SSE events are separated by a blank line.
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const eventText = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        processUpstreamEvent(eventText);
        separator = buffer.indexOf("\n\n");
      }

      // Be tolerant of CRLF-only boundaries.
      separator = buffer.indexOf("\r\n\r\n");
      while (separator >= 0) {
        const eventText = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 4);
        processUpstreamEvent(eventText);
        separator = buffer.indexOf("\r\n\r\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) processUpstreamEvent(buffer);
  } catch (err: any) {
    if (!res.writableEnded) {
      writeResponseEvent(res, "response.failed", ++sequence, {
        response: {
          ...buildCanonicalResponseFields(body, model, responseId, createdAt, "failed", output, responseUsage),
          error: {
            code: "upstream_stream_error",
            message: err?.message || String(err),
          },
        },
      });
    }
    clearInterval(keepAlive);
    try { res.end(); } catch {}
    return;
  }

  // Close any open message item.
  if (messageId) {
    const outputIndex = output.findIndex((item) => item.id === messageId);
    const finalText = textParts.join("");
    const outputItem = output[outputIndex];
    if (outputItem) {
      outputItem.status = "completed";
      outputItem.phase = "final_answer";
      outputItem.content = [{
        type: "output_text",
        text: finalText,
        annotations: [],
      }];
    }

    writeResponseEvent(res, "response.output_text.done", ++sequence, {
      item_id: messageId,
      output_index: outputIndex,
      content_index: 0,
      text: finalText,
    });
    writeResponseEvent(res, "response.content_part.done", ++sequence, {
      item_id: messageId,
      output_index: outputIndex,
      content_index: 0,
      part: {
        type: "output_text",
        text: finalText,
        annotations: [],
      },
    });
    writeResponseEvent(res, "response.output_item.done", ++sequence, {
      output_index: outputIndex,
      item: outputItem,
    });
  }

  // Finish every function call item with its complete argument string.
  for (const call of toolCalls.values()) {
    const outputIndex = output.findIndex((item) => item.id === call.id);
    const outputItem = output[outputIndex];
    if (outputItem) {
      outputItem.arguments = call.arguments || "{}";
      outputItem.name = call.name;
      outputItem.status = "completed";
    }

    writeResponseEvent(res, "response.function_call_arguments.done", ++sequence, {
      item_id: call.id,
      output_index: outputIndex,
      arguments: call.arguments || "{}",
    });
    writeResponseEvent(res, "response.output_item.done", ++sequence, {
      output_index: outputIndex,
      item: outputItem || {
        type: "function_call",
        id: call.id,
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments || "{}",
        status: "completed",
      },
    });
  }

  // Build the assistant Chat-Completions message that represents this turn.
  const assistantMessage: any = {
    role: "assistant",
    content: textParts.length ? textParts.join("") : null,
  };
  if (toolCalls.size) {
    assistantMessage.tool_calls = Array.from(toolCalls.values()).map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.arguments || "{}",
      },
    }));
  }

  const stored = {
    messages: [...messages, assistantMessage],
    createdAt: Date.now(),
    sessionId,
    model,
  };
  responseStore.set(responseId, stored);
  persistResponse(responseId, stored);

  const finalStatus = toolCalls.size ? "requires_action" : "completed";

  if (!sawTerminal) {
    // The gateway itself owns the Responses contract, so even if a Web2API
    // upstream ends with [DONE] or a clean EOF, Codex still receives the
    // terminal response.completed event it requires.
    writeResponseEvent(res, "response.completed", ++sequence, {
      response: {
        ...buildCanonicalResponseFields(body, model, responseId, createdAt, finalStatus, output, responseUsage),
        output_text: responseOutputText(output),
      },
    });
  }

  clearInterval(keepAlive);
  res.end();
}


// ─── Handlers ────────────────────────────────────────────────────────────────

function handleModelsRequest(res: ServerResponse): void {
  refreshQwenModelsIfNeeded();
  refreshChatGPTModelsIfNeeded();

  const modelList = getAllModels().map((id) => {
    const isGemini = GEMINI_MODELS.includes(id);
    const isChatGPT = isChatGPTModel(id);
    const isQwen = !isGemini && !isChatGPT;

    return {
      id,
      object: "model",
      created: 1700000000,
      owned_by: isGemini ? "google" : isChatGPT ? "openai" : "qwen",
      description: isGemini
        ? `Gemini model: ${id} (Fast Web2API — 20k tokens)`
        : isQwen
          ? `Qwen Cloud model: ${id} (qwen2api — dynamic discovery)`
          : isChatGPT
            ? `ChatGPT model: ${id} (reverse-chatgpt on port 5000; upstream model auto-selection)`
            : `Model: ${id}`,
      metadata: {
        backend: isGemini ? "gemini-web2api" : isQwen ? "qwen2api" : isChatGPT ? "reverse-chatgpt" : "gemini-web2api",
        auth: "none (zero login / no API key required)",
        max_tokens: 20000,
      },
    };
  });

  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify({ object: "list", data: modelList }, null, 2));
}

async function handleHealthRequest(res: ServerResponse): Promise<void> {
  const backendStatus = chatgptBackendReady ? "ready" : "unavailable";
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(
    JSON.stringify({
      status: "ok",
      service: "unified-api-router",
      backends: {
        gemini: GEMINI_BACKEND,
        qwen2api: QWEN2API_BACKEND,
        chatgpt_without_login: CHATGPT_BACKEND,
      },
      backend_status: {
        chatgpt: backendStatus,
        chatgpt_error: chatgptBackendError,
      },
      available_models: {
        gemini: GEMINI_MODELS,
        qwen: qwenModels,
        chatgpt: chatgptModels,
      },
      features: {
        token_limit: "20k+ tokens allowed (auto-continue enabled)",
        claude_compatible: "POST /v1/messages (Anthropic Messages protocol)",
        codex_compatible: "POST /v1/responses",
        image_generation: "POST /v1/images/generations",
        streaming: "True SSE token delivery",
      },
      auth: "zero credentials / no API keys required",
    })
  );
}

function serveFile(res: ServerResponse, filePath: string, contentType = "text/html; charset=utf-8"): void {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "page not available" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(content);
  });
}

async function parseJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  loadResponseJournal();
  console.log(`[Router] Fetching Qwen Cloud models from qwen2api (${QWEN2API_BACKEND})...`);
  await refreshQwenModelsIfNeeded();
  console.log(`[Router] Fetching ChatGPT models from reverse-chatgpt (${CHATGPT_BACKEND})...`);
  await refreshChatGPTModelsIfNeeded();
  if (qwenModels.length === 0) {
    qwenModels = getQwenFallbackModels();
  }
  if (chatgptModels.length === 0) {
    chatgptModels = getChatGPTFallbackModels();
  }
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // Support long-running completions (up to 10 minutes for 20k token code output)
  req.socket?.setTimeout(600000);
  res.socket?.setTimeout(600000);
  req.socket?.setNoDelay(true);
  res.socket?.setNoDelay(true);

  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;

  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version, x-requested-with");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  // Live Chat UI (default home & /chat)
  if ((pathname === "/" || pathname === "/chat" || pathname === "/chat/") && req.method === "GET") {
    serveFile(res, CHAT_PAGE);
    return;
  }

  // Local Script Share page
  if ((pathname === "/share" || pathname === "/share/") && req.method === "GET") {
    serveFile(res, SHARE_PAGE);
    return;
  }

  // Health check
  if (pathname === "/health" || pathname === "/v1/health") {
    await refreshChatGPTModelsIfNeeded();
    await handleHealthRequest(res);
    return;
  }

  // Model list
  if (pathname === "/v1/models" || pathname === "/models") {
    handleModelsRequest(res);
    return;
  }

  // Anthropic Claude Messages API (/v1/messages)
  if (pathname === "/v1/messages" && req.method === "POST") {
    try {
      const body = await parseJsonBody(req);
      console.log(`[${new Date().toISOString()}] Claude Messages '${body.model || "claude"}' (stream=${!!body.stream})`);
      await handleClaudeMessages(req, res, body);
    } catch (err: any) {
      console.error("Error in Claude messages handler:", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: err.message } }));
    }
    return;
  }

  // Chat completions (route based on model)
  if (pathname === "/v1/chat/completions" && req.method === "POST") {
    try {
      const body = await parseJsonBody(req);
      const model = body.model || "gemini-3.8-flash";
      const backendUrl = getBackendUrl(model);

      console.log(`[${new Date().toISOString()}] Routing '${model}' -> ${backendUrl} (stream=${Boolean(body.stream)})`);
      proxyRequest(req, res, backendUrl, JSON.stringify(body));
    } catch (err) {
      console.error("Error parsing chat completions body:", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Bad Request", type: "invalid_request_error" } }));
    }
    return;
  }

  // Image generations — route to qwen2api for Qwen models
  if (pathname === "/v1/images/generations" && req.method === "POST") {
    try {
      const body = await parseJsonBody(req);
      const model = body.model || "";
      if (!model || isQwenModel(model)) {
        console.log(`[${new Date().toISOString()}] Image generation '${model || "default"}' -> ${QWEN2API_BACKEND}`);
        proxyRequestToPath(req, res, QWEN2API_BACKEND, "/v1/images/generations", JSON.stringify(body));
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: { message: `Image generation not supported for model '${model}'. Use a Qwen model.`, type: "invalid_request_error" },
        }));
      }
    } catch (err) {
      console.error("Error parsing image generations body:", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Bad Request", type: "invalid_request_error" } }));
    }
    return;
  }

  // Responses endpoint for Codex CLI
  if (pathname === "/v1/responses" && req.method === "POST") {
    try {
      const body = await parseJsonBody(req);
      console.log(`[${new Date().toISOString()}] Codex Response '${body.model || "default"}'`);
      await handleResponsesRequest(res, body);
    } catch (err) {
      console.error("Error handling Responses request:", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Bad Request", type: "invalid_request_error" } }));
    }
    return;
  }

  // Default fallback for any /v1/*
  if (pathname.startsWith("/v1/")) {
    proxyRequest(req, res, GEMINI_BACKEND);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not Found", type: "invalid_request_error" } }));
});

// ─── Startup ─────────────────────────────────────────────────────────────────

await bootstrap();

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("==========================================================");
  console.log("  ⚡ Universal Web2API Gateway (Zero Auth / 20k Tokens)");
  console.log("==========================================================");
  console.log("");
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log(`Open Web Chat UI: http://${HOST}:${PORT}/chat`);
  console.log("");
  console.log("Endpoints:");
  console.log(`  GET  /                       - Live Streaming Chat UI`);
  console.log(`  GET  /chat                   - Live Streaming Chat UI`);
  console.log(`  GET  /health                 - Health check & features`);
  console.log(`  GET  /v1/models              - List all models (Gemini + Qwen + ChatGPT)`);
  console.log(`  POST /v1/chat/completions    - OpenAI Chat Completions (20k token allowance)`);
  console.log(`  POST /v1/messages            - Anthropic Claude Messages API (Claude Code / Cline)`);
  console.log(`  POST /v1/responses           - OpenAI Responses API (Codex CLI)`);
  console.log(`  POST /v1/images/generations  - Image generation (Qwen)`);
  console.log("");
  console.log("Backends & Models:");
  console.log(`  ⚡ Gemini:   ${GEMINI_BACKEND} (${GEMINI_MODELS.length} models, 20k token auto-continue)`);
  console.log(`              ${GEMINI_MODELS.join(", ")}`);
  console.log(`  🐉 Qwen:     ${QWEN2API_BACKEND} (${qwenModels.length} models — dynamic Qwen Cloud)`);
  console.log(`              ${qwenModels.join(", ")}`);
  console.log(`  🤖 ChatGPT:  ${CHATGPT_BACKEND} (${chatgptModels.length} backend-advertised models)`);
  console.log(`              ${chatgptModels.join(", ")}`);
  console.log("");
  console.log("Start backends:");
  console.log("  1. Gemini:     python gemini_web2api.py --port 8082");
  console.log("  2. Qwen2API:   cd qwen2api && node index.js");
  console.log("  3. ChatGPT:    cd reverse-chatgpt && venv\\Scripts\\python.exe -m uvicorn app:app --host 127.0.0.1 --port 5000");
  console.log("  4. Gateway:    npx tsx unified-api-router.ts");
  console.log("");
});

// Periodically refresh Qwen models in background
setInterval(() => {
  refreshQwenModelsIfNeeded();
  refreshChatGPTModelsIfNeeded();
}, QWEN_MODEL_REFRESH_MS);

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  server.close(() => process.exit(0));
});
