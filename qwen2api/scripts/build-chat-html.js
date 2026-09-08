#!/usr/bin/env node
/**
 * 从 chat.html 生成 chat-html.js（把页面内容内联为一个 CJS 模块）。
 *
 * 为什么需要：Vercel / Netlify 的 Node 函数环境只包含打包进函数包的代码，
 * 运行期 fs.readFileSync('chat.html') 读不到仓库文件（ENOENT）。
 * core.js 的 getChatHtml() 在磁盘读取失败时回退到这个内联副本。
 *
 * 修改 chat.html 后，重新运行本脚本即可同步：
 *   node scripts/build-chat-html.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const htmlPath = path.join(rootDir, 'chat.html');
const outPath = path.join(rootDir, 'chat-html.js');

const html = fs.readFileSync(htmlPath, 'utf-8');
// JSON.stringify 生成合法的 JS 字符串字面量（转义引号/反斜杠/换行）
const payload = JSON.stringify(html);

const header = `// 本文件由 scripts/build-chat-html.js 从 chat.html 自动生成，请勿手改。\n` +
  `// 修改 chat.html 后执行: node scripts/build-chat-html.js\n` +
  `// 生成时间: ${new Date().toISOString()}\n`;

fs.writeFileSync(outPath, header + 'module.exports = ' + payload + ';\n', 'utf-8');

const inBytes = Buffer.byteLength(html, 'utf-8');
const outBytes = fs.statSync(outPath).size;
console.log(`chat-html.js 已生成: ${outPath}`);
console.log(`  chat.html: ${inBytes} bytes -> chat-html.js: ${outBytes} bytes`);
