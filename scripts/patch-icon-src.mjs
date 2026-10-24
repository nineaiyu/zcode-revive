#!/usr/bin/env node
/**
 * patch-icon-src.mjs — 让 ZCode 设置界面支持 data URI 插件图标
 *
 * 背景：渲染端插件图标组件的守卫函数写死了只允许 https:// URL，本地
 * marketplace 插件的 data:image 图标会被显示为占位块。本补丁等长替换
 * 该判断，同时放行 https:// 与 data:image/。
 *
 * 版本自适应：守卫函数名随版本变化（0.16: mD，0.17: JD），按函数体
 * 特征定位——「单参、函数体恰为 return typeof e==`string`&&e.startsWith(`https://`)」。
 * 多参变体（如 find(...) 版本）不会被匹配，绝不误改。
 *
 * 原位字节替换（asar 数据区等长覆写，不重新打包）；首次 apply 自动备份。
 *
 * 用法：
 *   node patch-icon-src.mjs apply     # 应用（幂等）
 *   node patch-icon-src.mjs revert    # 还原
 *   node patch-icon-src.mjs status    # 查看状态
 * 注意：需要先完全退出 ZCode；ZCode 升级会覆盖补丁，升级后重新 apply。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCAL_PATHS = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./.local-paths.json', import.meta.url), 'utf8'));
  } catch {
    return {};
  }
})();

const ASAR = process.env.ZCODE_ASAR_PATH || LOCAL_PATHS.appAsar
  || path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ZCode', 'resources', 'app.asar');

// 守卫特征：function X(e){return typeof e==`string`&&e.startsWith(`https://`)}
const GUARD_RE = /function \w+\(e\)\{return typeof e==`string`&&e\.startsWith\(`https:\/\/`\)\}/g;
const INNER_OLD = 'return typeof e==`string`&&e.startsWith(`https://`)';
const INNER_NEW = 'return /^https:|^data:image\\//.test(e)';

function parseAsar(buf) {
  const headerSize = buf.readUInt32LE(4);
  const jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString('utf8'));
  return { header, dataStart: 8 + headerSize };
}

function collectFiles(node, prefix, out) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      collectFiles(child, prefix ? `${prefix}/${name}` : name, out);
    }
  } else if (typeof node.offset === 'string' && typeof node.size === 'number') {
    out.push({ path: prefix, offset: Number(node.offset), size: node.size });
  }
}

function scan(buf) {
  const { header, dataStart } = parseAsar(buf);
  const files = [];
  collectFiles(header, '', files);
  const states = [];
  for (const f of files) {
    const start = dataStart + f.offset;
    const text = buf.slice(start, start + f.size).toString('utf8');
    const guards = [...text.matchAll(GUARD_RE)];
    const patched = text.includes(INNER_NEW);
    if (guards.length || patched) states.push({ path: f.path, start, size: f.size, guards, patched });
  }
  return states;
}

const command = process.argv[2] || 'status';
const buf = fs.readFileSync(ASAR);
const states = scan(buf);

if (command === 'status') {
  console.log(`app.asar: ${ASAR}`);
  if (!states.length) console.log('状态: 未找到守卫函数（可能客户端结构大改）');
  for (const s of states) {
    console.log(`  ${s.path}: ${s.patched ? '已补丁' : `原始（${s.guards.length} 处守卫）`}`);
  }
} else if (command === 'apply') {
  const needPatch = states.filter((s) => !s.patched && s.guards.length);
  if (!needPatch.length) {
    if (states.some((s) => s.patched)) {
      console.log('已是补丁状态，无需重复应用');
      process.exit(0);
    }
    console.error('未找到目标守卫函数，未做修改');
    process.exit(1);
  }
  const backup = ASAR + '.bak';
  if (!fs.existsSync(backup)) {
    console.log('备份 app.asar ->', backup);
    fs.copyFileSync(ASAR, backup);
  }
  const innerOld = Buffer.from(INNER_OLD, 'utf8');
  const innerNew = Buffer.from(INNER_NEW, 'utf8');
  if (innerNew.length > innerOld.length) throw new Error('替换串比原文长，无法等长覆写');
  const padded = Buffer.concat([innerNew, Buffer.alloc(innerOld.length - innerNew.length, 0x20)]);
  let count = 0;
  const patchedPaths = [];
  for (const s of needPatch) {
    for (const g of s.guards) {
      const abs = s.start + g.index + g[0].indexOf(INNER_OLD);
      padded.copy(buf, abs); // 等长原位覆写
      count += 1;
    }
    patchedPaths.push(s.path);
  }
  fs.writeFileSync(ASAR, buf);
  console.log(`已补丁 ${count} 处守卫（${patchedPaths.join(', ')}）`);
  console.log('重启 ZCode 后图标即可显示');
} else if (command === 'revert') {
  const backup = ASAR + '.bak';
  if (!fs.existsSync(backup)) {
    console.error('未找到备份', backup);
    process.exit(1);
  }
  fs.copyFileSync(backup, ASAR);
  console.log('已还原，重启 ZCode 后生效');
} else {
  console.error('用法: node patch-icon-src.mjs apply | revert | status');
  process.exit(1);
}
