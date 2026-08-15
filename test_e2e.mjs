// 端到端测试:本地假上游验证受限/解锁/注入剥离(不触网)
// 用法:node test_e2e.mjs
import http from 'node:http';
import assert from 'node:assert/strict';

const ECHO_PORT = 8799;
const PROXY_PORT = Number(process.env.PROXY_PORT || 8788);

// 记录上游收到的请求体
let received = [];
const echo = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'mock', choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
  });
});

await new Promise((r) => echo.listen(ECHO_PORT, '127.0.0.1', r));

// 启动代理(指向假上游)
process.env.UPSTREAM_BASE_URL = `http://127.0.0.1:${ECHO_PORT}`;
process.env.PORT = String(PROXY_PORT);
const { server } = await import('./server.mjs');
await new Promise((r) => server.listen(PROXY_PORT, '127.0.0.1', r));

function post(path, body) {
  return fetch(`http://127.0.0.1:${PROXY_PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const allTools = [
  { type: 'function', function: { name: 'Bash', description: 'Executes a command in the shell, returning stdout, stderr, and exit code.\n- Working directory persists between calls, but prefer absolute paths. This is a long description with lots of usage rules and git guidance that must be kept for high-frequency tools.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'Read', description: 'Reads a file from the local filesystem', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'Write', description: 'Writes a file to the local filesystem', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'Skill', description: '技能', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'EnterPlanMode', description: 'Use this tool proactively when you are about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'mcp__node_repl__js', description: '执行JS', parameters: { type: 'object', properties: {} } } },
];
const skillsMsg = '<system-reminder>\nThe following skills are available for use with the Skill tool:\n- superpowers:brainstorming\n</system-reminder>';
const agentsMdMsg = '<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n# agentsMd\nContents of C:\\Users\\<user>\\AGENTS.md (workspace instructions):\n规则内容...\n</system-reminder>';
const sysMsg = { role: 'system', content: 'You are ZCode, an interactive coding agent' };

// ---- 场景 1:首轮请求 → 受限,工具只剩 Bash/Read,注入被剥离 ----
const r1 = await post('/chat/completions', {
  model: 'deepseek-v4-flash',
  messages: [sysMsg, { role: 'user', content: skillsMsg }, { role: 'user', content: agentsMdMsg }, { role: 'user', content: '你好,看看这个项目' }],
  tools: allTools,
  stream: false,
});
assert.equal(r1.status, 200);
const got1 = JSON.parse(received[0].body);
assert.deepEqual(got1.tools.map((t) => t.function.name), ['Bash', 'Read'], '首轮 tools 应只剩 Bash/Read');
assert.equal(got1.messages.length, 2, '首轮应剥离 2 条注入消息');
assert.equal(got1.messages[0].content, 'You are a helpful software engineer assistant.', '极简模式:系统提示词应被替换');
assert.ok(!got1.messages.some((m) => m.content === skillsMsg), 'skills 注入不应存在');
assert.ok(!got1.messages.some((m) => m.content === agentsMdMsg), 'AGENTS.md 注入不应存在');

// ---- 场景 2:同会话,历史中调用了 Bash → 解锁,全部透传 ----
const r2 = await post('/chat/completions', {
  model: 'deepseek-v4-flash',
  messages: [
    sysMsg,
    { role: 'user', content: skillsMsg },
    { role: 'user', content: agentsMdMsg },
    { role: 'user', content: '你好,看看这个项目' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '文件列表' },
    { role: 'user', content: '继续' },
  ],
  tools: allTools,
  stream: false,
});
assert.equal(r2.status, 200);
const got2 = JSON.parse(received[1].body);
assert.equal(got2.tools.length, allTools.length, '解锁后全部工具透传');
assert.equal(got2.messages[0].content, 'You are a helpful software engineer assistant.', '解锁后:系统提示词仍为极简 persona');
assert.ok(got2.messages.some((m) => m.content === skillsMsg), '解锁后:skills 注入保留');
assert.ok(!got2.messages.some((m) => m.content === agentsMdMsg), '解锁后:AGENTS.md 注入剥离');
assert.equal(got2.messages.length, 6, '解锁后剥离 AGENTS.md(system+skills+user+assistant+tool+user)');

// smart 模式(L1):解锁后 EnterPlanMode 描述压成一句,Bash 描述保留
if (process.env.TOOL_DESC_MODE === 'smart') {
  const ent = got2.tools.find((t) => t.function.name === 'EnterPlanMode');
  const bash = got2.tools.find((t) => t.function.name === 'Bash');
  assert.ok(ent && ent.function.description.length < 150, 'L1:EnterPlanMode 描述应压成一句');
  assert.ok(bash && bash.function.description.length > 150, 'L1:Bash 描述应完整保留');
}

// ---- 场景 3:不同会话,从未调用工具 → 持续受限 ----
const r3 = await post('/chat/completions', {
  model: 'deepseek-v4-flash',
  messages: [
    sysMsg,
    { role: 'user', content: skillsMsg },
    { role: 'user', content: agentsMdMsg },
    { role: 'user', content: '另一个会话,只聊天' },
    { role: 'assistant', content: '纯文本回复' },
    { role: 'user', content: '继续聊' },
  ],
  tools: allTools,
  stream: false,
});
assert.equal(r3.status, 200);
const got3 = JSON.parse(received[2].body);
assert.deepEqual(got3.tools.map((t) => t.function.name), ['Bash', 'Read'], '未调用工具应持续受限');
assert.equal(got3.messages.length, 4, '受限期注入剥离(system+2条user+assistant)');

// ---- 场景 4:健康检查 ----
const st = await fetch(`http://127.0.0.1:${PROXY_PORT}/status`).then((r) => r.json());
assert.equal(st.status, 'ok');
assert.equal(st.restricted, 2, '受限计数应为 2');
assert.equal(st.unlocked, 1, '解锁计数应为 1');

console.log('端到端测试全部通过 ✓ (首轮受限→调用解锁→未调用持续受限→注入剥离)');
server.close(() => {
  echo.close(() => process.exit(0));
});
