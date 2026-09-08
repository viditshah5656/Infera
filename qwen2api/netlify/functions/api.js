/**
 * Netlify Functions 入口 - Node 运行时（非 Edge Function）
 *
 * netlify.toml 通过 [[redirects]] 将 /v1/*、/chat、/ 重写到
 * /.netlify/functions/api，由本函数统一处理。
 *
 * 与 Edge Function 的区别：
 * - Netlify Functions 在返回前会缓冲完整响应，因此 stream=true 的请求
 *   会被 core.js 收集整段 SSE 后一次性返回（语义不变，非实时推送）。
 * - 超时时间在 netlify.toml 中配置：同步函数上限 Pro/Enterprise 26s、
 *   免费 Hobby 10s。
 * - 无法运行 Chromium/yt-dlp，token 走简化获取方式。
 */

const {
  handleModels,
  handleChatCompletions,
  handleChatCompletionsWithLogs,
  handleImageGenerations,
  handleRoot,
  handleChatPage,
} = require('../../core.js');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const NETLIFY_FN_PREFIX = '/.netlify/functions/api';

function normalizePath(event) {
  let pathname = event.path || '';
  try {
    pathname = new URL(pathname, 'http://localhost').pathname;
  } catch {}
  if (pathname === NETLIFY_FN_PREFIX) return '/';
  if (pathname.startsWith(NETLIFY_FN_PREFIX + '/')) {
    const rest = pathname.slice(NETLIFY_FN_PREFIX.length);
    return rest || '/';
  }
  return pathname;
}

function parseBody(event) {
  if (!event.body) return {};
  let text = event.body;
  if (event.isBase64Encoded) {
    try {
      text = Buffer.from(event.body, 'base64').toString('utf8');
    } catch {
      return {};
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function toNetlifyResponse(result) {
  if (!result || typeof result.statusCode !== 'number') {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'No response from handler', type: 'api_error' } }),
    };
  }
  return {
    statusCode: result.statusCode,
    headers: { ...CORS_HEADERS, ...(result.headers || {}) },
    body: typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const pathname = normalizePath(event);
  const authHeader = event.headers?.authorization || event.headers?.Authorization || '';

  if (event.httpMethod === 'GET' && pathname === '/v1/models') {
    return toNetlifyResponse(await handleModels(authHeader));
  }

  if (event.httpMethod === 'POST' && pathname === '/v1/chat/completions/log') {
    return toNetlifyResponse(await handleChatCompletionsWithLogs(parseBody(event), authHeader));
  }

  if (event.httpMethod === 'POST' && pathname === '/v1/chat/completions') {
    return toNetlifyResponse(await handleChatCompletions(parseBody(event), authHeader));
  }

  if (event.httpMethod === 'POST' && pathname === '/v1/images/generations') {
    return toNetlifyResponse(await handleImageGenerations(parseBody(event), authHeader));
  }

  if (event.httpMethod === 'GET' && (pathname === '/chat' || pathname === '/chat/')) {
    return toNetlifyResponse(handleChatPage());
  }

  if (event.httpMethod === 'GET' && (pathname === '/' || pathname === '')) {
    return toNetlifyResponse(handleRoot());
  }

  return {
    statusCode: 404,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }),
  };
};
