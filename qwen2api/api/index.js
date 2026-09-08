/**
 * Vercel Node.js 入口 - 复用 core.js（与本地 / Netlify 同一套逻辑）
 *
 * 说明：
 * - 从 Edge Runtime 切换为 Node Runtime，因此可以直接 require CommonJS 的 core.js。
 * - stream=true 时通过 createExpressStreamHandler 实时转发上游 SSE（Vercel Node
 *   函数原生支持流式响应），与本地 Express 行为一致。
 * - 超时通过 module.exports.config.maxDuration 配置：Hobby 上限 60s，Pro 可更高。
 * - 无法运行 Chromium / yt-dlp，token 走简化获取方式。
 */

const {
  handleModels,
  handleChatCompletions,
  handleChatCompletionsWithLogs,
  handleImageGenerations,
  handleRoot,
  handleChatPage,
  createExpressStreamHandler,
  createExpressLogStreamHandler,
} = require('../core.js');

const API_PREFIX = '/api';

function normalizePath(req) {
  let pathname = req.url || req.path || '';
  try {
    pathname = new URL(pathname, 'http://localhost').pathname;
  } catch {}
  if (pathname === API_PREFIX) return '/';
  if (pathname.startsWith(API_PREFIX + '/')) {
    const rest = pathname.slice(API_PREFIX.length);
    return rest || '/';
  }
  return pathname;
}

function parseBody(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body || {};
}

function sendResult(res, result) {
  const headers = result.headers || {};
  for (const key of Object.keys(headers)) {
    if (headers[key] !== undefined && headers[key] !== null) {
      res.setHeader(key, headers[key]);
    }
  }
  return res.status(result.statusCode).send(result.body);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const pathname = normalizePath(req);
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';

  if (req.method === 'GET' && pathname === '/v1/models') {
    return sendResult(res, await handleModels(authHeader));
  }

  if (req.method === 'POST' && pathname === '/v1/chat/completions/log') {
    const result = await handleChatCompletionsWithLogs(parseBody(req), authHeader, undefined, createExpressLogStreamHandler(res));
    if (res.headersSent) {
      if (!res.writableEnded && result && typeof result.statusCode === 'number') {
        let payload = { error: { message: `HTTP ${result.statusCode}`, type: 'api_error' } };
        try {
          const parsed = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
          if (parsed && parsed.error) {
            payload = parsed;
          } else if (result.statusCode >= 200 && result.statusCode < 300 && parsed) {
            payload = parsed;
          }
        } catch {}
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
      return;
    }
    if (result && typeof result.statusCode === 'number') {
      return sendResult(res, result);
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    const result = await handleChatCompletions(parseBody(req), authHeader, undefined, createExpressStreamHandler(res));
    if (result && typeof result.statusCode === 'number') {
      return sendResult(res, result);
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/v1/images/generations') {
    return sendResult(res, await handleImageGenerations(parseBody(req), authHeader));
  }

  if (req.method === 'GET' && (pathname === '/chat' || pathname === '/chat/')) {
    return sendResult(res, handleChatPage());
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
    return sendResult(res, handleRoot());
  }

  return res.status(404).json({ error: { message: 'Not found', type: 'invalid_request_error' } });
};

// Vercel 函数最大执行时长（秒）：
// - Hobby 计划硬顶 60s（超出的配置会被钳制到 60）
// - Pro 计划最高 300s，Enterprise 最高 800s
// 附件上传（OSS PUT + 状态轮询）耗时较长，Pro 及以上请保持较大值。
module.exports.config = { maxDuration: 300 };
