/**
 * 用系统 Chrome 无头模式运行 baxia SDK，获取真实的 bx-ua / bx-umidtoken。
 * 启动 Chrome headless + CDP，加载 chat.qwen.ai，
 * 等待 window.__baxia__.getFYModule 就绪，调用 getUidToken() / getFYToken()。
 * 结果缓存复用。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  // 常见 Snap 安装位置
  '/snap/bin/chromium',
  '/snap/bin/google-chrome',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  // 兜底：从 PATH 里找（跨平台通用）
  try {
    const pathEnv = process.env.PATH || '';
    const exts = process.platform === 'win32'
      ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
      : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome'];
    for (const dir of pathEnv.split(path.delimiter)) {
      if (!dir) continue;
      for (const name of exts) {
        const candidate = path.join(dir, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch (e) {}
  return null;
}

const CACHE_TTL = 25 * 60 * 1000; // 25 分钟
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
let cache = null;
let cacheTime = 0;
let chromeProc = null;
let chromePort = 0;

function randomPort() {
  return 9400 + Math.floor(Math.random() * 600);
}

function startChrome() {
  if (chromeProc && !chromeProc.killed) return chromeProc;
  const exe = findChrome();
  if (!exe) throw new Error('Chrome not found. Set CHROME_PATH env var.');
  chromePort = randomPort();
  const userDataDir = path.join(os.tmpdir(), 'qwen2api-ch-' + process.pid + '-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });
  chromeProc = spawn(exe, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--remote-debugging-port=' + chromePort,
    '--user-data-dir=' + userDataDir,
    '--window-size=1280,800',
    '--user-agent=' + UA,
    'about:blank',
  ], { stdio: 'ignore' });
  chromeProc.on('exit', () => { chromeProc = null; });
  chromeProc.on('error', () => { chromeProc = null; });
  return chromeProc;
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => {
      resolve({
        ws,
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
      });
    };
    ws.onerror = () => reject(new Error('CDP ws error'));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
      }
    };
  });
}

async function getBaxiaTokens() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) {
    return cache;
  }

  startChrome();
  let pageWsUrl = '';
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${chromePort}/json/list`)).json();
      const page = Array.isArray(list) ? list.find(t => t.type === 'page') : null;
      if (page && page.webSocketDebuggerUrl) {
        pageWsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  if (!pageWsUrl) throw new Error('Chrome CDP page not reachable');

  const cdp = await cdpConnect(pageWsUrl);
  let result = null;
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: 'https://chat.qwen.ai/' });

    let uid = '', fy = '', ver = '', cookies = '';
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      let val = null;
      try {
        const ev = await cdp.send('Runtime.evaluate', {
          expression: `(function(){
            var fm = (window.__baxia__||{}).getFYModule;
            if (!fm || !fm.fyObj) return { ready: false };
            var uid='', fy='';
            try { uid = String(fm.getUidToken()); } catch(e) {}
            try { fy = String(fm.getFYToken()); } catch(e) {}
            return { ready: true, uid: uid, fy: fy, ver: fm.fyObj.ver || '', cookie: document.cookie || '' };
          })()`,
          returnByValue: true,
        });
        val = ev && ev.result && ev.result.value;
      } catch (e) {}
      if (val && val.ready && typeof val.uid === 'string' && /^T2gA/i.test(val.uid) && val.uid.length > 20) {
        uid = val.uid;
        fy = val.fy;
        ver = val.ver;
        cookies = val.cookie || '';
        break;
      }
    }

    if (!uid) {
      throw new Error('Failed to get baxia uid token after waiting');
    }

    cache = { bxUa: fy || ('231!' + uid), bxUmidToken: uid, bxV: '2.5.37', ver, cookies };
    cacheTime = now;
    result = cache;
  } finally {
    try { cdp.ws.close(); } catch (e) {}
    killChrome();
  }
  return result;
}

function killChrome() {
  if (chromeProc) {
    try { chromeProc.kill(); } catch (e) {}
    chromeProc = null;
  }
}

function stop() {
  killChrome();
}

module.exports = { getBaxiaTokens, stop, findChrome, CACHE_TTL };
