#!/usr/bin/env node
/**
 * patch-epipe-retryable.mjs — 让 EPIPE 类连接中断走客户端自动重试
 *
 * 背景：模型请求在传输层遭遇连接被掐断（write EPIPE）时，ZCode 的失败分类器
 * 把错误码与「网络错误白名单」比对后决定是否重试。白名单里有 ECONNRESET /
 * ECONNREFUSED / EAI_AGAIN / ENOTFOUND / ENETUNREACH / EHOSTUNREACH /
 * UND_ERR_SOCKET / UND_ERR_CONNECT_TIMEOUT，唯独没有 EPIPE —— 于是 EPIPE
 * 落到兜底分支被判 retryable=false，一次都不重试直接 turn.failed。
 * 该路径不触发任何钩子，revive 插件无法介入。
 *
 * 补丁：在白名单中插入 EPIPE，使其与 ECONNRESET 同样按网络错误重试
 * （沿用客户端自身 maxRetries 的退避策略）。只加这一个错误码：
 * ERR_STREAM_DESTROYED / ECONNABORTED 等可能伴随主动取消，纳入有误重试风险。
 *
 * 用法：
 *   node patch-epipe-retryable.mjs apply    # 应用补丁（幂等）
 *   node patch-epipe-retryable.mjs revert   # 还原为本补丁应用前的状态
 *   node patch-epipe-retryable.mjs status   # 查看当前状态
 *
 * 注意：
 *   - ZCode 升级会覆盖 zcode.cjs，升级后需重新 apply（按内容特征定位，不依赖变量名）。
 *   - 备份为 zcode.cjs.epipe.bak（首次 apply 时创建）。revert 还原的是「打本补丁前」
 *     的状态；若之前已打过 patch-retry-table.mjs，还原结果仍包含那张补丁。
 *   - 与 patch-retry-table.mjs 相互独立：那张管「Start Plan 繁忙」重试表，本张管 EPIPE。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 可选的本地路径覆盖（不入库）：scripts/.local-paths.json -> { "zcodeCjs": "..." }
function localOverride() {
  try {
    return JSON.parse(fs.readFileSync(new URL('./.local-paths.json', import.meta.url), 'utf8')).zcodeCjs;
  } catch {
    return undefined;
  }
}

const CANDIDATES = [
  process.env.ZCODE_CJS_PATH,
  localOverride(),
  'C:/Program Files/ZCode/resources/glm/zcode.cjs',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
  '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
].filter(Boolean);

// 版本自适应：按内容特征定位网络错误白名单（变量名压缩后随版本变化，用反向引用约束同一变量）。
// 原始链：t==="ECONNRESET"||t==="ECONNREFUSED"||t==="EAI_AGAIN"||t==="ENOTFOUND"
//        ||t==="ENETUNREACH"||t==="EHOSTUNREACH"||t==="UND_ERR_SOCKET"||t==="UND_ERR_CONNECT_TIMEOUT"
// 注意：代码里的 || 是字面量，正则中必须转义为 \|\|，否则会被当成分支匹配。
const CHAIN_PARTS = [
  '(\\w{1,3})==="ECONNRESET"',
  '\\1==="ECONNREFUSED"',
  '\\1==="EAI_AGAIN"',
  '\\1==="ENOTFOUND"',
  '\\1==="ENETUNREACH"',
  '\\1==="EHOSTUNREACH"',
  '\\1==="UND_ERR_SOCKET"',
  '\\1==="UND_ERR_CONNECT_TIMEOUT"',
];
const ORIGINAL_RE = new RegExp(CHAIN_PARTS.join('\\|\\|'), 'g');
const PATCHED_RE = new RegExp(
  CHAIN_PARTS.join('\\|\\|').replace(
    '==="ECONNRESET"',
    '==="ECONNRESET"\\|\\|\\1==="EPIPE"',
  ),
  'g',
);

function locate() {
  for (const file of CANDIDATES) {
    if (fs.existsSync(file)) return file;
  }
  throw new Error('未找到 zcode.cjs，可用 ZCODE_CJS_PATH 环境变量或 scripts/.local-paths.json 指定路径');
}

function status(file) {
  const text = fs.readFileSync(file, 'utf8');
  const original = [...text.matchAll(ORIGINAL_RE)];
  const patched = [...text.matchAll(PATCHED_RE)];
  if (patched.length > 0) return { state: 'patched', count: patched.length };
  if (original.length > 0) return { state: 'original', count: original.length };
  return { state: 'not-found', count: 0 };
}

function applyPatch(file) {
  const backup = file + '.epipe.bak';
  let text = fs.readFileSync(file, 'utf8');
  const matches = [...text.matchAll(ORIGINAL_RE)];
  if (matches.length === 0) {
    console.error('未找到网络错误白名单（可能版本更新再次改变了代码），未做修改');
    process.exit(1);
  }
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(file, backup);
    console.log('已备份当前文件 ->', backup);
  }
  // 从后往前替换，避免偏移失效
  let count = 0;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const m = matches[i];
    const v = m[1];
    const replacement = m[0].replace(`${v}==="ECONNRESET"`, `${v}==="ECONNRESET"||${v}==="EPIPE"`);
    text = text.slice(0, m.index) + replacement + text.slice(m.index + m[0].length);
    count += 1;
  }
  fs.writeFileSync(file, text);
  console.log(`已在 ${count} 处白名单插入 EPIPE：EPIPE 连接中断将按网络错误自动重试`);
  console.log('重启 ZCode 后生效');
}

const command = process.argv[2] || 'status';
const file = locate();

if (command === 'status') {
  console.log(`zcode.cjs: ${file}`);
  const s = status(file);
  console.log(`EPIPE 重试补丁: ${s.state}（${s.count} 处）`);
} else if (command === 'apply') {
  const s = status(file);
  if (s.state === 'patched') console.log('已是补丁状态，无需重复应用');
  else applyPatch(file);
} else if (command === 'revert') {
  const backup = file + '.epipe.bak';
  if (!fs.existsSync(backup)) {
    console.error('未找到备份文件', backup);
    process.exit(1);
  }
  fs.copyFileSync(backup, file);
  console.log('已还原为本补丁应用前的 zcode.cjs，重启 ZCode 后生效');
} else {
  console.error('用法: node patch-epipe-retryable.mjs apply | revert | status');
  process.exit(1);
}
