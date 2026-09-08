/**
 * Cloudflare Workers 入口 - 复用 core.js（与本地 / Vercel / Netlify 同一套逻辑）
 *
 * 使用方法:
 * 1. 安装 wrangler: npm install -g wrangler
 * 2. 登录: wrangler login
 * 3. 部署: wrangler deploy
 *
 * 说明:
 * - 依赖 wrangler.toml 中的 nodejs_compat 兼容标志（提供 Buffer / process 等）。
 * - core.js 中所有 Node 内置模块均通过 nodeRequire 动态加载，在 CF Worker 上
 *   自动降级（无 fs / child_process / Chromium / yt-dlp）。
 * - stream=true 时通过 TransformStream 实时转发上游 SSE，与本地 Express 行为一致。
 * - 聊天页 /chat 由 core.js 提供：磁盘可读时读 chat.html，否则用打包进
 *   chat-html.js 的内联副本（由 scripts/build-chat-html.js 生成）。
 */

import core from './core.js';

const {
  handleModels,
  handleChatCompletions,
  handleChatCompletionsWithLogs,
  handleImageGenerations,
  handleRoot,
  handleChatPage,
  createExpressStreamHandler,
  createExpressLogStreamHandler,
} = core;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
  });
}

function toCfResponse(result) {
  if (!result || typeof result.statusCode !== 'number') {
    return jsonResponse({ error: { message: 'No response from handler', type: 'api_error' } }, 500);
  }
  return new Response(result.body, { status: result.statusCode, headers: result.headers });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// 用 TransformStream 构造一个 "res 形状" 的 sink，让 core.js 的 SSE 流写入器直接可用。
// fakeRes 只需支持 setHeader / write / end / writableEnded / headersSent。
function createCfStreamingSink() {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const fakeRes = {
    headers: {},
    writableEnded: false,
    headersSent: false,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    write(chunk) {
      if (this.writableEnded) return;
      this.headersSent = true;
      writer.write(encoder.encode(String(chunk))).catch(() => {});
    },
    end() {
      if (this.writableEnded) return;
      this.writableEnded = true;
      writer.close().catch(() => {});
    },
  };
  return { readable, fakeRes };
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const authHeader = request.headers.get('Authorization') || '';

    // GET /v1/models
    if (request.method === 'GET' && pathname === '/v1/models') {
      return toCfResponse(await handleModels(authHeader, env));
    }

    // POST /v1/chat/completions/log（带日志的流式对话）
    if (request.method === 'POST' && pathname === '/v1/chat/completions/log') {
      const { readable, fakeRes } = createCfStreamingSink();
      const result = await handleChatCompletionsWithLogs(await readJson(request), authHeader, env, createExpressLogStreamHandler(fakeRes));
      if (fakeRes.headersSent) {
        // 流式过程中出现错误 / 完成时，把最终结果作为 SSE 数据帧追加
        if (!fakeRes.writableEnded && result && typeof result.statusCode === 'number') {
          let payload = { error: { message: `HTTP ${result.statusCode}`, type: 'api_error' } };
          try {
            const parsed = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
            if (parsed && parsed.error) {
              payload = parsed;
            } else if (result.statusCode >= 200 && result.statusCode < 300 && parsed) {
              payload = parsed;
            }
          } catch {}
          fakeRes.write(`data: ${JSON.stringify(payload)}\n\n`);
          fakeRes.write('data: [DONE]\n\n');
          fakeRes.end();
        }
        return new Response(readable, { status: 200, headers: fakeRes.headers });
      }
      if (result && typeof result.statusCode === 'number') {
        return toCfResponse(result);
      }
      return new Response(readable, { status: 200, headers: fakeRes.headers });
    }

    // POST /v1/chat/completions（流式 / 非流式）
    if (request.method === 'POST' && pathname === '/v1/chat/completions') {
      const { readable, fakeRes } = createCfStreamingSink();
      const result = await handleChatCompletions(await readJson(request), authHeader, env, createExpressStreamHandler(fakeRes));
      if (result && typeof result.statusCode === 'number') {
        // 非流式或错误：直接返回 JSON
        return toCfResponse(result);
      }
      // 流式：headers 已由流写入器设置
      return new Response(readable, { status: 200, headers: fakeRes.headers });
    }

    // POST /v1/images/generations
    if (request.method === 'POST' && pathname === '/v1/images/generations') {
      return toCfResponse(await handleImageGenerations(await readJson(request), authHeader, env));
    }

    // GET /chat 聊天页面（由 core.js 提供，含内联副本兜底）
    if (request.method === 'GET' && (pathname === '/chat' || pathname === '/chat/')) {
      return toCfResponse(handleChatPage());
    }

    // GET / 根路径
    if (request.method === 'GET' && (pathname === '/' || pathname === '')) {
      return toCfResponse(handleRoot());
    }

    return jsonResponse({ error: { message: 'Not found', type: 'invalid_request_error' } }, 404);
  },
};
