// ZCode 工具链渐进解锁代理(零依赖,Node 18+ 自带 fetch)
//
// 功能:会话受限期内对齐 @deepseek-ai/dsh「极简模式」(minimal preset)工作流——
//       - 系统提示词替换为固定极简文本(如 "You are a helpful software engineer assistant.",
//         persona complete:true 语义,禁止追加任何提示文本)
//       - 剥离全部 <system-reminder> 运行时上下文注入(includeRuntimeContext:false 语义,
//         含 skills / AGENTS.md / plan 模式 / Bash shell 提示等)
//       - 工具只保留白名单(默认 Bash,Read)
//       一旦模型调用过白名单工具(如 Bash/Read),下一轮请求起进入「解锁态」:
//       - 工具全量恢复(46 个系统工具 + MCP 工具)
//       - 系统提示词仍保持 dsh 极简 persona(思维不被行为准则/安全文本污染)
//       - 仅保留 ZCode skills 注入(工具与技能可用),AGENTS.md / plan / Bash 提示等其余注入全部过滤
//
// 判定依据(OpenAI chat/completions 请求体):
//   - 解锁条件:请求历史中出现 assistant 消息且其 tool_calls 包含白名单工具名
//   - 会话键:第一条非注入 user 消息(真实用户输入)的 SHA-1,compact 请求不会误判
//
// 配置(优先级:环境变量 > config.json > 默认值):
//   config.json 字段                    环境变量                    默认值
//   port                               PORT                        8788
//   upstream("opencode"|"deepseek"|URL) UPSTREAM_BASE_URL          opencode
//   firstRoundTools(数组或字符串)       FIRST_ROUND_TOOLS          Bash,Read
//   minimalSystemPrompt                 MINIMAL_SYSTEM_PROMPT      "You are a helpful software engineer assistant."
//   stripAllReminders(兼容保留)         STRIP_ALL_REMINDERS        true
//   stripInjections                     STRIP_INJECTIONS           true
//   enableUnlock                        ENABLE_UNLOCK              true
//   unlockKeepMinimal(解锁后保持极简)   UNLOCK_KEEP_MINIMAL        true
//   unlockKeepSkills(解锁后保留skills)  UNLOCK_KEEP_SKILLS         true
//   dumpDir(仅环境变量)                 DUMP_DIR                   关闭
//   logFile(仅环境变量)                 LOG_FILE                   关闭

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(HERE, 'config.json');

function loadFileConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}
const fileConfig = loadFileConfig();

function pick(key, env, def) {
  if (process.env[env] !== undefined) return process.env[env];
  if (fileConfig[key] !== undefined) return fileConfig[key];
  return def;
}
function toBool(v, def) {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null || v === '') return def;
  return !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase());
}

// 上游解析:内置 opencode / deepseek 两个快捷选项,也可直接填完整 URL
function resolveUpstream(v) {
  const s = String(v || '').trim();
  if (s === 'opencode') return 'https://opencode.ai/zen/go/v1';
  if (s === 'deepseek') return 'https://api.deepseek.com';
  return s.replace(/\/+$/, '');
}

const PORT = Number(pick('port', 'PORT', 8788));
const UPSTREAM = resolveUpstream(pick('upstream', 'UPSTREAM_BASE_URL', 'opencode'));
const rawTools = pick('firstRoundTools', 'FIRST_ROUND_TOOLS', 'Bash,Read');
const ALLOWED_TOOLS = (Array.isArray(rawTools) ? rawTools : String(rawTools).split(','))
  .map((s) => String(s).trim()).filter(Boolean);
const STRIP_INJECTIONS = toBool(pick('stripInjections', 'STRIP_INJECTIONS', true), true);
// STRIP_ALL_REMINDERS=true(默认):受限期剥离全部 <system-reminder> 注入
// (对齐 dsh 极简模式 includeRuntimeContext=false);=false 时仅剥离 skills/AGENTS.md 注入。
const STRIP_ALL_REMINDERS = toBool(pick('stripAllReminders', 'STRIP_ALL_REMINDERS', true), true);
// MINIMAL_SYSTEM_PROMPT:受限期系统提示词替换为固定极简文本(对齐 dsh 极简模式 persona complete: true);
// 设为空字符串则保留客户端原始系统提示词。
const MINIMAL_SYSTEM_PROMPT = pick('minimalSystemPrompt', 'MINIMAL_SYSTEM_PROMPT', 'You are a helpful software engineer assistant.');
const ENABLE_UNLOCK = toBool(pick('enableUnlock', 'ENABLE_UNLOCK', true), true);
// UNLOCK_KEEP_MINIMAL=true(默认):解锁后系统提示词仍保持 dsh 极简 persona,
// 不再恢复客户端原始系统提示词(避免行为准则/安全文本污染思维链)。
const UNLOCK_KEEP_MINIMAL = toBool(pick('unlockKeepMinimal', 'UNLOCK_KEEP_MINIMAL', true), true);
// UNLOCK_KEEP_SKILLS=true(默认):解锁后保留 ZCode skills 注入,其余注入
// (AGENTS.md / plan / Bash 提示等)仍全部过滤。
const UNLOCK_KEEP_SKILLS = toBool(pick('unlockKeepSkills', 'UNLOCK_KEEP_SKILLS', true), true);
// TOOL_DESC_MODE:解锁后工具描述精简策略。
//   full  = 原样保留(默认);
//   smart = 修正版 L1:高频防误用工具(Bash/Read/Write/Edit/Skill)完整保留,
//           复杂参数工具(Cron/AskUserQuestion/Agent/Enter·ExitPlanMode)工具级描述压成一句、参数描述保留,
//           其余系统工具描述压成一句、参数描述截断 40 字符,MCP 工具不动。
const TOOL_DESC_MODE = String(pick('toolDescMode', 'TOOL_DESC_MODE', 'full')).toLowerCase();
const DUMP_DIR = process.env.DUMP_DIR || '';
const LOG_FILE = process.env.LOG_FILE || '';

// ---------------- 纯函数(可单测) ----------------

// 是否为客户端注入的 user 消息(<system-reminder> 包裹的 skills/AGENTS.md/模式提示等)
export function isInjectionMessage(m) {
  if (!m || m.role !== 'user') return false;
  const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
  return text.trimStart().startsWith('<system-reminder>');
}

// 会话键:第一条「非注入」user 消息文本的 SHA-1(前 16 位)。
// 真实请求中首条 user 消息常为 skills/AGENTS.md 注入,若以注入消息为键会导致所有会话同键;
// 取第一条真实用户输入作为键。无真实输入时回退为全部消息的哈希。
export function sessionKeyOf(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const firstRealUser = messages.find((m) => m && m.role === 'user' && !isInjectionMessage(m));
  const target = firstRealUser || messages.find((m) => m && m.role === 'user');
  if (!target) return null;
  let text = '';
  const content = target.content;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part.text === 'string') text += part.text;
      else if (typeof part === 'string') text += part;
    }
  }
  if (!text.trim()) return null;
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

// 是否已调用过白名单工具(解锁条件)
export function hasUsedAllowedTool(messages, allowed) {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) =>
    m && m.role === 'assistant' && Array.isArray(m.tool_calls) &&
    m.tool_calls.some((tc) => tc && tc.function && allowed.includes(tc.function.name))
  );
}

// tools 过滤为白名单
export function filterTools(tools, allowed) {
  if (!Array.isArray(tools)) return tools;
  return tools.filter((t) => t && t.function && allowed.includes(t.function.name));
}

// 剥离注入消息。
// Bash shell 提示(Bash tool shell is Git Bash)始终保留——模型需要知道工具底层 shell 类型;
// 其余按模式处理:
// mode="all"(受限期):剥离其余所有 <system-reminder>(skills/AGENTS.md/plan 等);
// mode="keep-skills"(解锁后):保留 skills 注入 + Bash 提示,剥离其余;
// mode="selective":仅剥离 skills 与 AGENTS.md 注入,保留 plan/Bash 等。
const SKILLS_RE = /The following skills are available for use/;
const BASH_SHELL_RE = /The Bash tool shell is Git Bash/;
const AGENTSMD_RE = /(?:#\s*agentsMd|Contents of .*AGENTS\.md|As you answer the user's questions, you can use the following context)/;
export function stripInjectedMessages(messages, mode = 'all') {
  return messages.filter((m) => {
    if (!m || m.role !== 'user') return true;
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    const isReminder = text.trimStart().startsWith('<system-reminder>');
    if (!isReminder) return true;
    if (BASH_SHELL_RE.test(text)) return true; // Bash shell 提示始终保留
    if (mode === 'keep-skills') return SKILLS_RE.test(text);
    if (mode === 'selective') return !(SKILLS_RE.test(text) || AGENTSMD_RE.test(text));
    return false; // 'all'
  });
}

// 系统提示词替换为极简文本(未配置时跳过);返回是否发生变更
function applyMinimalSystemPrompt(messages) {
  if (!MINIMAL_SYSTEM_PROMPT) return false;
  let changed = false;
  for (const m of messages) {
    if (m && m.role === 'system' && typeof m.content === 'string' && m.content !== MINIMAL_SYSTEM_PROMPT) {
      m.content = MINIMAL_SYSTEM_PROMPT;
      changed = true;
    }
  }
  return changed;
}

// ---------------- 工具描述精简(L1 smart 模式) ----------------
// 高频防误用工具:完整保留(含使用规则,删了会误用)
const KEEP_FULL_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'Skill']);
// 复杂参数工具:工具级描述压成一句,参数描述完整保留(调用契约是正确传参的关键)
const KEEP_PARAM_TOOLS = new Set(['CronCreate', 'CronUpdate', 'CronDelete', 'CronList',
  'AskUserQuestion', 'Agent', 'EnterPlanMode', 'ExitPlanMode']);
// 简单工具:工具级描述压成一句,参数描述截断
const SIMPLE_TOOLS = new Set(['WebFetch', 'TodoRead', 'TodoWrite', 'TaskOutput', 'TaskStop',
  'SendMessage', 'ReadSessionContext',
  'mcp__node_repl__js', 'mcp__node_repl__js_add_node_module_dir', 'mcp__node_repl__js_reset']);
const PARAM_DESC_LIMIT = 40;

// 取描述第一句(到句号/换行),超过 limit 截断
function firstSentence(text, limit = 120) {
  const t = String(text || '').trim();
  if (!t) return '';
  const m = t.match(/^(.{1,200}?)(?:\.\s|\n|$)/);
  const s = m ? m[1] : t;
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

// 对 tools 应用 smart 精简;返回是否发生变更(纯函数,可单测)
// 白名单式精简:不在任何名单中的工具(含插件后续新增)一律原样保留,不影响新插件。
export function slimTools(tools) {
  if (!Array.isArray(tools)) return false;
  let changed = false;
  for (const t of tools) {
    const fn = t && t.function;
    if (!fn) continue;
    const name = fn.name || '';
    if (name.startsWith('mcp__') && !SIMPLE_TOOLS.has(name)) continue; // MCP 描述已短,不动
    if (KEEP_FULL_TOOLS.has(name)) continue;      // 高频防误用,完整保留
    if (!SIMPLE_TOOLS.has(name) && !KEEP_PARAM_TOOLS.has(name)) continue; // 未知工具(新增插件)原样保留
    const params = fn.parameters && fn.parameters.properties;
    if (typeof fn.description === 'string' && fn.description.length > 0) {
      const brief = firstSentence(fn.description, 120);
      if (brief !== fn.description) { fn.description = brief; changed = true; }
      // 仅简单工具:参数描述也截断(复杂参数工具保留参数描述)
      if (SIMPLE_TOOLS.has(name) && params && typeof params === 'object') {
        for (const v of Object.values(params)) {
          if (v && typeof v.description === 'string' && v.description.length > PARAM_DESC_LIMIT) {
            v.description = v.description.slice(0, PARAM_DESC_LIMIT) + '…';
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

// ---------------- 会话状态 ----------------

// 会话键 → { unlocked: boolean }
const sessions = new Map();
let statRestricted = 0;
let statUnlocked = 0;
let statStrippedInjections = 0;

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  console.log(text);
  if (LOG_FILE) {
    try { fs.appendFileSync(path.resolve(LOG_FILE), text + '\n'); } catch { /* 日志失败不影响服务 */ }
  }
}

// 处理请求体:返回 { parsed, changed, unlocked, isNewUnlock }
export function processBody(parsed) {
  const messages = parsed.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { parsed, changed: false, unlocked: true, isNewUnlock: false };
  }
  const key = sessionKeyOf(messages);
  const state = key ? (sessions.get(key) || { unlocked: false }) : { unlocked: true };

  // 解锁判定:历史中出现过白名单工具调用
  if (ENABLE_UNLOCK && !state.unlocked && hasUsedAllowedTool(messages, ALLOWED_TOOLS)) {
    state.unlocked = true;
    if (key) sessions.set(key, state);
    return applyUnlockedPolicy(parsed, true);
  }

  if (state.unlocked) {
    if (key) sessions.set(key, state);
    return applyUnlockedPolicy(parsed, false);
  }

  // 受限期:对齐 @deepseek-ai/dsh「极简模式」(minimal preset)工作流 ——
  //   1. 系统提示词替换为固定极简文本(persona complete: true 语义,禁止任何追加提示文本)
  //   2. 剥离全部 <system-reminder> 运行时上下文注入(includeRuntimeContext: false 语义)
  //   3. 工具只保留白名单(默认 Bash/Read)
  let changed = false;
  if (Array.isArray(parsed.tools)) {
    const filtered = filterTools(parsed.tools, ALLOWED_TOOLS);
    if (filtered.length !== parsed.tools.length) {
      parsed.tools = filtered;
      changed = true;
    }
  }
  if (STRIP_INJECTIONS) {
    const filteredMsgs = stripInjectedMessages(messages, 'all');
    if (filteredMsgs.length !== messages.length) {
      parsed.messages = filteredMsgs;
      statStrippedInjections += messages.length - filteredMsgs.length;
      changed = true;
    }
  }
  if (applyMinimalSystemPrompt(parsed.messages)) changed = true;
  if (key) sessions.set(key, state);
  return { parsed, changed, unlocked: false, isNewUnlock: false };
}

// 解锁后策略:思维保持 dsh 极简模式(系统提示词仍为极简 persona),
// 工具全量恢复,仅保留 ZCode skills 注入,其余注入(AGENTS.md/plan/Bash 提示等)全部过滤。
// UNLOCK_KEEP_MINIMAL=false 时恢复客户端原始系统提示词;UNLOCK_KEEP_SKILLS=false 时 skills 注入也过滤。
function applyUnlockedPolicy(parsed, isNewUnlock) {
  let changed = false;
  if (UNLOCK_KEEP_MINIMAL && applyMinimalSystemPrompt(parsed.messages)) changed = true;
  if (UNLOCK_KEEP_SKILLS) {
    const filteredMsgs = stripInjectedMessages(parsed.messages, 'keep-skills');
    if (filteredMsgs.length !== parsed.messages.length) {
      parsed.messages = filteredMsgs;
      statStrippedInjections += parsed.messages.length - filteredMsgs.length;
      changed = true;
    }
  }
  // 工具描述精简(L1 smart 模式):保持工具能力与安全,压缩方法论型描述
  if (TOOL_DESC_MODE === 'smart' && slimTools(parsed.tools)) changed = true;
  return { parsed, changed, unlocked: true, isNewUnlock };
}

// ---------------- HTTP 服务 ----------------

function buildHeaders(source, url) {
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    const key = k.toLowerCase();
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive',
      'proxy-connection', 'upgrade', 'te', 'trailer', 'accept-encoding'].includes(key)) continue;
    out[key] = v;
  }
  out.host = url.host;
  return out;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();

  // 健康检查:GET /status
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok', port: PORT, upstream: UPSTREAM,
      firstRoundTools: ALLOWED_TOOLS,
      minimalSystemPrompt: MINIMAL_SYSTEM_PROMPT,
      stripAllReminders: STRIP_ALL_REMINDERS,
      stripInjections: STRIP_INJECTIONS, enableUnlock: ENABLE_UNLOCK,
      unlockKeepMinimal: UNLOCK_KEEP_MINIMAL, unlockKeepSkills: UNLOCK_KEEP_SKILLS,
      toolDescMode: TOOL_DESC_MODE,
      restricted: statRestricted, unlocked: statUnlocked,
      strippedInjections: statStrippedInjections, sessions: sessions.size,
    }, null, 2));
    return;
  }

  let aborted = false;
  // 注意:IncomingMessage 的 'close' 在请求体读完时也会触发,不能用来判定客户端断开;
  // 改用 'aborted'(仅客户端中断触发)与底层 socket 关闭来判定。
  req.on('aborted', () => { aborted = true; });
  req.socket?.on('close', () => { aborted = true; });

  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (aborted) return;
    const raw = Buffer.concat(chunks);

    // 路径归一化:若上游 baseURL 以 /v1 结尾(如 .../zen/go/v1),而请求路径也以 /v1 开头
    // (ZCode 界面填 baseURL 时可能习惯性带 /v1),则去掉请求路径的前导 /v1,避免 /v1/v1 重复。
    let reqPath = req.url || '/';
    if (/\/v1\/?$/.test(new URL(UPSTREAM).pathname) && reqPath.startsWith('/v1/')) {
      reqPath = reqPath.slice(3);
    }
    const upstreamUrl = new URL(UPSTREAM + reqPath);

    let body = raw;
    let status = '透传';
    let isNewUnlock = false;

    // 仅处理 chat/completions 的 JSON 请求
    if (req.method === 'POST' && /\/chat\/completions$/.test(upstreamUrl.pathname) && raw.length > 0) {
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        if (parsed && Array.isArray(parsed.messages)) {
          const result = processBody(parsed);
          isNewUnlock = result.isNewUnlock;
          status = result.unlocked ? (isNewUnlock ? '解锁' : '已解锁') : `受限(${ALLOWED_TOOLS.join('/')})`;
          if (result.changed) body = Buffer.from(JSON.stringify(result.parsed));
          if (result.unlocked) statUnlocked += 1; else statRestricted += 1;
        }
      } catch {
        // 非 JSON 或解析失败:原样转发
      }
    }

    const upRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: buildHeaders(req.headers, upstreamUrl),
      body: body.length > 0 ? body : undefined,
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });

    // 调试转储:转发给上游的请求体(JSON 美化缩进后写入,便于阅读)
    if (DUMP_DIR) {
      try {
        fs.mkdirSync(DUMP_DIR, { recursive: true });
        const safeStatus = String(status).replace(/[\\/:*?"<>|]/g, '_');
        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeStatus}-${upRes.status}.json`;
        let text = body.toString('utf8');
        try {
          text = JSON.stringify(JSON.parse(text), null, 2); // 美化 JSON
        } catch { /* 非 JSON 内容原样写入 */ }
        fs.writeFileSync(path.join(DUMP_DIR, name), text);
      } catch (e) { console.error('[转储失败]', e.message); }
    }

    const respHeaders = {};
    for (const [k, v] of upRes.headers.entries()) {
      const key = k.toLowerCase();
      if (['content-encoding', 'content-length', 'connection', 'transfer-encoding'].includes(key)) continue;
      respHeaders[key] = v;
    }
    res.writeHead(upRes.status, respHeaders);

    if (upRes.body) {
      const reader = upRes.body.getReader();
      for (;;) {
        if (aborted) { await reader.cancel(); break; }
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    if (!aborted) res.end();

    log(`状态=${status} ${req.method} ${req.url} -> ${upRes.status} ${Date.now() - started}ms (受限${statRestricted}/解锁${statUnlocked}/剥离注入${statStrippedInjections})`);
  } catch (err) {
    log(`错误 ${req.method} ${req.url}: ${err.message}${err.cause ? ' | 原因: ' + (err.cause.code || err.cause.message) : ''}`);
    if (!res.headersSent && !aborted) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `代理转发失败: ${err.message}` } }));
    }
  }
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  server.listen(PORT, '127.0.0.1', () => {
    log(`ZCode 工具链渐进解锁代理已启动: http://127.0.0.1:${PORT} -> ${UPSTREAM}`);
    log(`受限期工具: ${ALLOWED_TOOLS.join('/')} | 注入剥离: ${STRIP_INJECTIONS ? '开' : '关'} | 解锁: ${ENABLE_UNLOCK ? '开' : '关'}`);
  });
}

export { server };
