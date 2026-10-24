#!/usr/bin/env node
/**
 * patch-retry-table.mjs — 给 ZCode 客户端的「Start Plan 繁忙 / 并发超限」重试机制打补丁
 *
 * 背景（v0.2.1 实测复盘）：
 * 「当前系统繁忙，请切换模型、升级账户，或稍后再试」横幅背后是服务端在 SSE 流里
 * 下发的错误（典型消息 "model concurrency limit exceeded"，GLM 错误码 1302 系）。
 * 客户端回合级重试的判定 v8e() 只认错误码 {3008, 3009, 3010}：
 *   - 1302/1303/1305 等并发限流码不在白名单；
 *   - SSE 错误事件若未被解析出数字码，链路上根本没有码可查。
 * 两种情况 v8e() 都返回 false → L3o() 返回 undefined → 不重试 → turn 直接失败。
 * 该失败路径不触发任何钩子，revive 插件无法介入，只能补客户端。
 *
 * 补丁内容（全部幂等、按结构匹配、不依赖压缩后的变量名）：
 *   1. 重试延迟：每次重试随机 3–13 秒（3e3+1e4*Math.random()），替代固定退避表；
 *   2. 错误码白名单 {3008,3009,3010} → 追加 {1302,1303,1305} 并发限流码；
 *   3. v8e() 增加消息兜底：错误链上任何一层 message 命中
 *      /concurrency|busy|overload|繁忙/i 即视为可重试（覆盖无码场景）；
 *   4. 适配器层错误分类（toAdapterError 的 fallback 分支）同样按消息兜底判
 *      retryable=true——会话水合（hydrate-trace）等**不走主回合循环**的后台
 *      模型请求只依赖这层分类，否则并发错误仍会一次不试直接失败；
 *   5. （仅对官方原始文件）扩写重试表档数 2 → 10（P3o=10 次上限的配套长度）。
 *
 * 用法：
 *   node patch-retry-table.mjs apply    # 应用补丁（幂等）
 *   node patch-retry-table.mjs revert   # 还原为官方原始文件
 *   node patch-retry-table.mjs status   # 查看当前状态
 *
 * 注意：ZCode 升级会覆盖 zcode.cjs，升级后需重新执行 apply。
 * 原始文件备份为 zcode.cjs.bak（首次 apply 时自动创建），改完需重启 ZCode 生效。
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

// 10 档延迟表（旧补丁遗留：档数配套 P3o=10 的重试上限；取值已被随机延迟取代，
// 仅 U3o「目标验证」重试循环仍在用这张表的数值）
const PATCHED_TABLE = '[1e3,2e3,5e3,1e4,15e3,3e4,45e3,6e4,6e4,6e4]';

const RANDOM_DELAY = '3e3+1e4*Math.random()';
const FALLBACK_SNIPPET = 'concurrency|busy|overload|繁忙';
const EXTRA_CODES = '"1302","1303","1305"';

function locate() {
  for (const file of CANDIDATES) {
    if (fs.existsSync(file)) return file;
  }
  throw new Error('未找到 zcode.cjs，可用 ZCODE_CJS_PATH 环境变量或 scripts/.local-paths.json 指定路径');
}

// ---------------------------------------------------------------------------
// 结构化补丁：每个补丁用正则定位（跨版本稳定），带已应用检测与幂等替换
// ---------------------------------------------------------------------------

const PATCHES = [
  {
    id: 'random-delay',
    describe: '重试延迟改为每次随机 3–13 秒',
    // …&&v8e(e.error))return D3o[e.state.streamRecoveryRetryCount]  →  return 3e3+1e4*Math.random()
    detect: (text) => text.includes(`)return ${RANDOM_DELAY}`),
    regex: /has\(e\.providerId\)&&([\w$]+)\(e\.error\)\)return [\w$]+\[e\.state\.streamRecoveryRetryCount\]/,
    replace: (text) =>
      text.replace(
        /has\(e\.providerId\)&&([\w$]+)\(e\.error\)\)return [\w$]+\[e\.state\.streamRecoveryRetryCount\]/,
        (_m, fn) => `has(e.providerId)&&${fn}(e.error))return ${RANDOM_DELAY}`,
      ),
  },
  {
    id: 'retry-codes',
    describe: '错误码白名单追加 1302/1303/1305（并发限流）',
    // R3o=new Set(["3008","3009","3010"])  →  追加 1302/1303/1305
    detect: (text) => new RegExp(`[\\w$]+=new Set\\(\\["3008","3009","3010","1302"`).test(text),
    regex: /[\w$]+=new Set\(\["3008","3009","3010"\]\)/,
    replace: (text) =>
      text.replace(
        /([\w$]+)=new Set\(\["3008","3009","3010"\]\)/,
        (_m, name) => `${name}=new Set(["3008","3009","3010",${EXTRA_CODES}])`,
      ),
  },
  {
    id: 'message-fallback',
    describe: 'v8e 增加消息兜底匹配（concurrency/busy/overload/繁忙）',
    // if(o&&R3o.has(o))return!0}return!1}  →  …return!0;if(/…/i.test(…))return!0}return!1}
    detect: (text) => text.includes(FALLBACK_SNIPPET),
    regex: /if\(o&&[\w$]+\.has\(o\)\)return!0\}return!1\}/,
    replace: (text) =>
      text.replace(
        /if\(o&&([\w$]+)\.has\(o\)\)return!0\}return!1\}/,
        (_m, set) =>
          `if(o&&${set}.has(o))return!0;` +
          `if(/${FALLBACK_SNIPPET}/i.test(String(t&&t.message||"")))return!0}` +
          'return!1}',
      ),
  },
  {
    id: 'adapter-fallback',
    describe: '适配器层分类兜底：busy/concurrency 消息判为可重试（覆盖水合等非回合请求路径）',
    // let _=Uro(n);return{code:as.ModelRequestFailed,…,retryable:_,…}
    // → let _=/busy…/i.test(错误及其 cause 的消息)||Uro(n);return{…}
    detect: (text) => /let [\w$]+=\/concurrency\|busy\|overload\|繁忙\/i\.test/.test(text),
    regex: /let ([\w$]+)=([\w$]+)\(([\w$]+)\);return\{code:([\w$]+)\.ModelRequestFailed,message:\1\?"Provider marked the model request as retryable\./,
    replace: (text) => {
      const m = text.match(
        /let ([\w$]+)=([\w$]+)\(([\w$]+)\);return\{code:([\w$]+)\.ModelRequestFailed,message:\1\?"Provider marked the model request as retryable\./,
      );
      const [, fb, fn, arg, enumName] = m;
      return text.replace(m[0],
        `let ${fb}=/${FALLBACK_SNIPPET}/i.test(String(${arg}&&${arg}.message||"")` +
        `+String(${arg}&&${arg}.cause&&${arg}.cause.message||""))||${fn}(${arg});` +
        `return{code:${enumName}.ModelRequestFailed,message:${fb}?"Provider marked the model request as retryable.`);
    },
  },
];

// 旧补丁：扩写重试表档数（仅当文件仍是官方 2 档表时需要；已被 10 档则跳过）
function patchTable(text) {
  if (!/\[1e3,2e3\]/.test(text)) return { text, count: 0 };
  let count = 0;
  // 只动紧邻 start-plan 上下文的表，避免误伤无关代码
  text = text.replace(/([\w$]+)=\[1e3,2e3\]/g, (full, name, offset) => {
    const ctx = text.slice(Math.max(0, offset - 400), offset + 400);
    if (!ctx.includes('start-plan')) return full;
    count += 1;
    return `${name}=${PATCHED_TABLE}`;
  });
  return { text, count };
}

function inspect(text) {
  const applied = PATCHES.filter((p) => p.detect(text)).map((p) => p.id);
  return {
    randomDelay: applied.includes('random-delay'),
    retryCodes: applied.includes('retry-codes'),
    messageFallback: applied.includes('message-fallback'),
    adapterFallback: applied.includes('adapter-fallback'),
    tableExpanded: text.includes(PATCHED_TABLE),
  };
}

function applyPatch(file) {
  const backup = file + '.bak';
  let text = fs.readFileSync(file, 'utf8');
  const before = inspect(text);
  const changes = [];

  if (!before.tableExpanded) {
    const { text: next, count } = patchTable(text);
    if (count > 0) {
      text = next;
      changes.push(`重试表扩写 ${count} 处（2 档 → 10 档）`);
    }
  }
  for (const p of PATCHES) {
    if (p.detect(text)) continue; // 已应用
    if (!p.regex.test(text)) {
      console.error(`× 补丁「${p.id}」定位失败（客户端结构可能已变化），跳过该项`);
      continue;
    }
    text = p.replace(text);
    changes.push(p.describe);
  }

  if (changes.length === 0) {
    console.log('所有补丁均已应用，无需修改');
    return;
  }
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(file, backup);
    console.log('已备份原文件 ->', backup);
  }
  fs.writeFileSync(file, text);
  for (const c of changes) console.log('✓', c);
  console.log('重启 ZCode 后生效');
}

const command = process.argv[2] || 'status';
const file = locate();

if (command === 'status') {
  console.log(`zcode.cjs: ${file}`);
  const s = inspect(fs.readFileSync(file, 'utf8'));
  console.log(`随机延迟 3-13s: ${s.randomDelay ? '已应用' : '未应用'}`);
  console.log(`并发错误码白名单: ${s.retryCodes ? '已应用' : '未应用'}`);
  console.log(`消息兜底匹配: ${s.messageFallback ? '已应用' : '未应用'}`);
  console.log(`适配器层兜底: ${s.adapterFallback ? '已应用' : '未应用'}`);
  console.log(`重试表档数: ${s.tableExpanded ? '10 档' : '原始（未扩写）'}`);
} else if (command === 'apply') {
  applyPatch(file);
} else if (command === 'revert') {
  const backup = file + '.bak';
  if (!fs.existsSync(backup)) {
    console.error('未找到备份文件', backup);
    process.exit(1);
  }
  fs.copyFileSync(backup, file);
  console.log('已还原为官方原始 zcode.cjs，重启 ZCode 后生效');
} else {
  console.error('用法: node patch-retry-table.mjs apply | revert | status');
  process.exit(1);
}
