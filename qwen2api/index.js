/**
 * Qwen2API - 统一入口
 * 
 * 支持: Docker (Express) / Vercel / Netlify
 */

const { handleModels, handleChatCompletions, handleChatCompletionsWithLogs, handleImageGenerations, handleRoot, handleChatPage, createResponse, validateToken, uuidv4, mapUpstreamDeltaToOpenAI, tryParseUpstreamErrorPayload, createExpressStreamHandler, createExpressLogStreamHandler } = require('./core.js');

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function tryParseLooseJson(text) {
  // Best-effort recovery for PowerShell/curl quoting issues where JSON quotes are stripped,
  // e.g. {prompt:test} or {model:qwen3.5-plus,n:2}.
  // This keeps strict JSON behavior for normal clients, while making local debugging less painful.
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  if (!((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']')))) return null;

  // Quote unquoted object keys: {a:1, b:2} -> {"a":1, "b":2}
  s = s.replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');

  // Quote bare values after ':' when they are not valid JSON primitives.
  s = s.replace(/(:\s*)([^\s"\[{][^,}\]]*)/g, (match, prefix, rawValue) => {
    const value = String(rawValue || '').trim();
    if (!value) return match;
    if (value.startsWith('"') || value.startsWith('{') || value.startsWith('[')) return match;
    const lowered = value.toLowerCase();
    if (lowered === 'true' || lowered === 'false' || lowered === 'null') return `${prefix}${lowered}`;
    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return `${prefix}${value}`;
    return `${prefix}${JSON.stringify(value)}`;
  });

  return tryParseJson(s);
}

function logRequestPathBegin(runtime, path) {
  console.log(`[qwen2api][${runtime}][request.begin] path=${path}`);
}

function isHuggingFaceRuntime() {
  const hasPrimarySpaceId = Boolean(process.env.SPACE_ID);
  const hasAuthorRepo = Boolean(process.env.SPACE_AUTHOR_NAME && process.env.SPACE_REPO_NAME);
  const hasCreatorId = Boolean(process.env.SPACES_CREATOR_USER_ID);
  return Boolean(
    hasPrimarySpaceId ||
    hasAuthorRepo ||
    hasCreatorId ||
    process.env.HF_SPACE_ID ||
    process.env.HF_HOME ||
    process.env.HUGGINGFACE_SPACE_ID
  );
}

function patchDnsForHuggingFace() {
  if (!isHuggingFaceRuntime()) return;
  if (process.platform !== 'linux') return;

  const fs = require('fs');
  const resolvPath = '/etc/resolv.conf';
  const backupPath = '/etc/resolv.conf.bak';

  try {
    if (!fs.existsSync(resolvPath)) {
      console.log('[qwen2api][startup][dns] /etc/resolv.conf 不存在，跳过');
      return;
    }

    const stat = fs.lstatSync(resolvPath);
    if (!stat.isFile()) {
      console.log('[qwen2api][startup][dns] /etc/resolv.conf 非普通文件，跳过');
      return;
    }

    const original = fs.readFileSync(resolvPath, 'utf8');
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, original, 'utf8');
      console.log('✅ 已备份 /etc/resolv.conf 到 /etc/resolv.conf.bak');
    }

    let resolvContent = original;
    let changed = false;

    if (!/\b8\.8\.8\.8\b/.test(resolvContent)) {
      resolvContent = `nameserver 8.8.8.8\n${resolvContent}`;
      changed = true;
      console.log('✅ 已添加 DNS 8.8.8.8');
    }

    if (!/\b8\.8\.4\.4\b/.test(resolvContent)) {
      const lines = resolvContent.split(/\r?\n/);
      lines.splice(1, 0, 'nameserver 8.8.4.4');
      resolvContent = lines.join('\n');
      changed = true;
      console.log('✅ 已添加 DNS 8.8.4.4');
    }

    if (!changed) {
      console.log('[qwen2api][startup][dns] DNS 已包含 8.8.8.8 / 8.8.4.4，无需修改');
      return;
    }

    if (!resolvContent.endsWith('\n')) {
      resolvContent += '\n';
    }

    fs.writeFileSync(resolvPath, resolvContent, 'utf8');
  } catch (err) {
    console.log(`[qwen2api][startup][dns] 跳过 DNS 配置: ${err && err.message ? err.message : String(err)}`);
  }
}

// ============================================
// Serverless Handler (Vercel / Netlify)
// ============================================

async function serverlessHandler(req, res) {
  if (req.method === 'OPTIONS') {
    if (res) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      return res.status(200).end();
    }
    return createResponse('', 200);
  }
  
  const authHeader = req.headers?.authorization || req.headers?.Authorization || '';
  const path = req.url || req.path || '';
  let pathname = path;
  try {
    pathname = new URL(path, 'http://localhost').pathname;
  } catch {}

  const netlifyFnPrefix = '/.netlify/functions/api';
  const apiPrefix = '/api';
  const strippedFnPath = pathname === netlifyFnPrefix
    ? '/'
    : (pathname.startsWith(netlifyFnPrefix + '/') ? pathname.slice(netlifyFnPrefix.length) : pathname);
  const normalizedPathname = strippedFnPath === apiPrefix
    ? '/'
    : (strippedFnPath.startsWith(apiPrefix + '/') ? strippedFnPath.slice(apiPrefix.length) : strippedFnPath);

  if (req.method === 'GET' && normalizedPathname === '/v1/models') {
    const result = await handleModels(authHeader);
    if (res) return res.status(result.statusCode).set(result.headers).send(result.body);
    return result;
  }

  if (req.method === 'POST' && normalizedPathname === '/v1/chat/completions/log') {
    logRequestPathBegin('serverless', normalizedPathname);
    let body;
    try {
      if (typeof req.body === 'string') {
        body = tryParseJson(req.body) || tryParseLooseJson(req.body) || {};
      } else {
        body = req.body || {};
      }
    } catch {
      const bad = createResponse({ error: { message: 'Invalid JSON body.', type: 'invalid_request_error' } }, 400);
      if (res) return res.status(bad.statusCode).set(bad.headers).send(bad.body);
      return bad;
    }
    const result = await handleChatCompletionsWithLogs(body, authHeader);
    if (res) {
      if (result && result.body && result.headers && String(result.headers['Content-Type'] || '').indexOf('text/event-stream') === 0) {
        res.status(result.statusCode).set(result.headers).send(result.body);
        return;
      }
      return res.status(result.statusCode).set(result.headers).send(result.body);
    }
    return result;
  }

  if (req.method === 'POST' && normalizedPathname === '/v1/chat/completions') {
    logRequestPathBegin('serverless', normalizedPathname);
    let body;
    try {
      if (typeof req.body === 'string') {
        body = tryParseJson(req.body) || tryParseLooseJson(req.body) || {};
      } else {
        body = req.body || {};
      }
    } catch {
      const bad = createResponse({ error: { message: 'Invalid JSON body.', type: 'invalid_request_error' } }, 400);
      if (res) return res.status(bad.statusCode).set(bad.headers).send(bad.body);
      return bad;
    }
    const result = await handleChatCompletions(body, authHeader);
    if (res) {
      if (result && result.body && result.headers && String(result.headers['Content-Type'] || '').indexOf('text/event-stream') === 0) {
        res.status(result.statusCode).set(result.headers).send(result.body);
        return;
      }
      return res.status(result.statusCode).set(result.headers).send(result.body);
    }
    return result;
  }

  if (req.method === 'POST' && normalizedPathname === '/v1/images/generations') {
    logRequestPathBegin('serverless', normalizedPathname);
    let body;
    try {
      if (typeof req.body === 'string') {
        body = tryParseJson(req.body) || tryParseLooseJson(req.body) || {};
      } else {
        body = req.body || {};
      }
    } catch {
      const bad = createResponse({ error: { message: 'Invalid JSON body.', type: 'invalid_request_error' } }, 400);
      if (res) return res.status(bad.statusCode).set(bad.headers).send(bad.body);
      return bad;
    }
    const result = await handleImageGenerations(body, authHeader);
    if (res) return res.status(result.statusCode).set(result.headers).send(result.body);
    return result;
  }

  if (req.method === 'GET' && (normalizedPathname === '/chat' || normalizedPathname === '/chat/')) {
    const result = handleChatPage();
    if (res) return res.status(200).set(result.headers).send(result.body);
    return result;
  }

  if (req.method === 'GET' && normalizedPathname === '/') {
    const result = handleRoot();
    if (res) return res.status(200).set(result.headers).send(result.body);
    return result;
  }
  
  return res ? res.status(404).json({ error: { message: 'Not found', type: 'invalid_request_error' } }) : createResponse({ error: { message: 'Not found', type: 'invalid_request_error' } }, 404);
}

// ============================================
// Express Server (Docker / 本地开发)
// ============================================

function startExpressServer() {
  patchDnsForHuggingFace();

  const express = require('express');
  const app = express();
  const jsonLimit = process.env.JSON_BODY_LIMIT || '100mb';

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    next();
  });

  app.use(express.json({
    limit: jsonLimit,
    verify: (req, res, buf) => {
      try {
        req.rawBody = buf ? buf.toString('utf8') : '';
      } catch {
        req.rawBody = '';
      }
    }
  }));

  // req.rawBody is captured via express.json verify.

  app.use((error, req, res, next) => {
    if (!error) return next();
    if (error.type === 'entity.too.large' || error.status === 413) {
      return res.status(413).json({
        error: {
          message: `Payload too large. Current JSON body limit is ${jsonLimit}. You can increase it with JSON_BODY_LIMIT.`,
          type: 'invalid_request_error',
        },
      });
    }
    if (error.type === 'entity.parse.failed' || error.status === 400) {
      const raw = typeof req.rawBody === 'string' ? req.rawBody : '';
      const salvaged = tryParseLooseJson(raw);
      if (salvaged && typeof salvaged === 'object') {
        // Replace body and continue to route handler.
        req.body = salvaged;
        return next();
      }
      return res.status(400).json({
        error: {
          message: 'Invalid JSON body.',
          type: 'invalid_request_error',
        },
      });
    }
    return next(error);
  });

  // Token 验证中间件
  function authMiddleware(req, res, next) {
    if (!validateToken(req.headers.authorization)) {
      return res.status(401).json({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } });
    }
    next();
  }

  app.get('/v1/models', authMiddleware, async (req, res) => {
    const result = await handleModels(req.headers.authorization);
    res.status(result.statusCode).set(result.headers).send(result.body);
  });

  app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
    logRequestPathBegin('express', req.path || '/v1/chat/completions');
    const result = await handleChatCompletions(req.body, req.headers.authorization, null, createExpressStreamHandler(res));
    if (result && typeof result.statusCode === 'number') {
      res.status(result.statusCode).set(result.headers).send(result.body);
    }
  });

  app.post('/v1/chat/completions/log', authMiddleware, async (req, res) => {
    logRequestPathBegin('express', req.path || '/v1/chat/completions/log');
    const result = await handleChatCompletionsWithLogs(req.body, req.headers.authorization, null, createExpressLogStreamHandler(res));
    if (res.headersSent) {
      if (!res.writableEnded && result && typeof result.statusCode === 'number') {
        let payload = { error: { message: `HTTP ${result.statusCode}`, type: 'api_error' } };
        try {
          const parsed = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
          if (parsed && parsed.error) {
            payload = parsed;
          } else if (result.statusCode >= 200 && result.statusCode < 300 && parsed) {
            // 非流式成功响应（stream 未传或为 false）：日志事件已开始 SSE，
            // 将完整 completion 作为 data 事件输出，保证内容仍能送达。
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
      res.status(result.statusCode).set(result.headers).send(result.body);
    }
  });

  app.post('/v1/images/generations', authMiddleware, async (req, res) => {
    logRequestPathBegin('express', req.path || '/v1/images/generations');
    const result = await handleImageGenerations(req.body, req.headers.authorization);
    res.status(result.statusCode).set(result.headers).send(result.body);
  });

  app.get('/', (req, res) => {
    const result = handleRoot();
    res.status(200).set(result.headers).send(result.body);
  });

  app.get('/chat', (req, res) => {
    const result = handleChatPage();
    res.status(200).set(result.headers).send(result.body);
  });

  app.get('/chat/', (req, res) => {
    const result = handleChatPage();
    res.status(200).set(result.headers).send(result.body);
  });

  const PORT = process.env.PORT || 8765;
  app.listen(PORT, '0.0.0.0', () => console.log(`Qwen2API server running on port ${PORT}`));
}

// ============================================
// 导出 & 入口判断
// ============================================

module.exports = serverlessHandler;
module.exports.handleModels = handleModels;
module.exports.handleChatCompletions = handleChatCompletions;
module.exports.handleChatCompletionsWithLogs = handleChatCompletionsWithLogs;
module.exports.handleRoot = handleRoot;
module.exports.createResponse = createResponse;

const isServerless = process.env.VERCEL === '1' || process.env.NETLIFY === 'true';
if (!isServerless && require.main === module) {
  startExpressServer();
}
