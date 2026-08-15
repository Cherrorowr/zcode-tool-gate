// 逻辑单元测试:node test.mjs
import assert from 'node:assert/strict';
import { sessionKeyOf, hasUsedAllowedTool, filterTools, stripInjectedMessages } from './server.mjs';

const ALLOWED = ['Bash', 'Read'];

// ---------- sessionKeyOf ----------
assert.equal(sessionKeyOf([{ role: 'user', content: '相同文本' }]), sessionKeyOf([{ role: 'user', content: '相同文本' }]), '会话键应稳定');
assert.notEqual(sessionKeyOf([{ role: 'user', content: '文本A' }]), sessionKeyOf([{ role: 'user', content: '文本B' }]), '不同文本键应不同');
assert.equal(sessionKeyOf([]), null, '空消息无键');

// 首条 user 为注入消息时,键应取第一条真实用户消息(否则所有会话同键)
const inj1 = '<system-reminder>\nThe following skills are available for use with the Skill tool:\n- x\n</system-reminder>';
assert.notEqual(
  sessionKeyOf([{ role: 'user', content: inj1 }, { role: 'user', content: '会话A的开场' }]),
  sessionKeyOf([{ role: 'user', content: inj1 }, { role: 'user', content: '会话B的开场' }]),
  '注入消息相同但真实消息不同 → 会话键应不同'
);
assert.equal(
  sessionKeyOf([{ role: 'user', content: inj1 }, { role: 'user', content: '会话A的开场' }]),
  sessionKeyOf([{ role: 'user', content: inj1 }, { role: 'user', content: '会话A的开场' }]),
  '同会话键应稳定'
);
// 全是注入时回退:键 = 注入消息哈希(稳定,至少保证会话有键)
assert.equal(
  sessionKeyOf([{ role: 'system', content: 'sys' }, { role: 'user', content: inj1 }]),
  sessionKeyOf([{ role: 'system', content: 'sys' }, { role: 'user', content: inj1 }]),
  '全是注入时回退键应稳定'
);

// ---------- hasUsedAllowedTool(解锁条件) ----------
// 场景 1:assistant 调用了 Bash → 解锁
assert.equal(hasUsedAllowedTool([
  { role: 'user', content: 'x' },
  { role: 'assistant', content: null, tool_calls: [{ function: { name: 'Bash' } }] },
  { role: 'tool', content: 'ok' },
], ALLOWED), true, '调用过 Bash 应解锁');

// 场景 2:assistant 调用了 Read → 解锁
assert.equal(hasUsedAllowedTool([
  { role: 'assistant', tool_calls: [{ function: { name: 'Read' } }] },
], ALLOWED), true, '调用过 Read 应解锁');

// 场景 3:只调用了其他工具(Write)→ 不解锁
assert.equal(hasUsedAllowedTool([
  { role: 'assistant', tool_calls: [{ function: { name: 'Write' } }] },
], ALLOWED), false, '调用 Write 不应解锁');

// 场景 4:没有 tool_calls → 不解锁
assert.equal(hasUsedAllowedTool([
  { role: 'user', content: 'x' },
  { role: 'assistant', content: '纯文本回复' },
], ALLOWED), false, '无工具调用不解锁');

// 场景 5:mcp 工具调用 → 不解锁
assert.equal(hasUsedAllowedTool([
  { role: 'assistant', tool_calls: [{ function: { name: 'mcp__node_repl__js' } }] },
], ALLOWED), false, 'mcp 调用不解锁');

// ---------- filterTools(受限期白名单) ----------
const allTools = [
  { type: 'function', function: { name: 'Bash', description: '执行命令' } },
  { type: 'function', function: { name: 'Read', description: '读文件' } },
  { type: 'function', function: { name: 'Write', description: '写文件' } },
  { type: 'function', function: { name: 'Edit', description: '编辑' } },
  { type: 'function', function: { name: 'mcp__plugin_android-emulator_android-emulator__android_tap', description: '点按' } },
  { type: 'function', function: { name: 'Skill', description: '技能' } },
];
const kept = filterTools(allTools, ALLOWED);
assert.deepEqual(kept.map((t) => t.function.name), ['Bash', 'Read'], '受限期应只保留 Bash/Read');
assert.equal(filterTools(null, ALLOWED), null, '无 tools 字段应原样返回');

// ---------- stripInjectedMessages(注入剥离) ----------
const skillsMsg = '<system-reminder>\nThe following skills are available for use with the Skill tool:\n- superpowers:brainstorming\n</system-reminder>';
const agentsMdMsg = '<system-reminder>\nAs you answer the user\'s questions, you can use the following context:\n# agentsMd\nContents of C:\\Users\\<user>\\AGENTS.md (workspace instructions):\n...\n</system-reminder>';
const planMsg = '<system-reminder>\nPlan mode is active. The user indicated that they want you to act as their project manager.\n</system-reminder>';
const bashMsg = '<system-reminder>\nThe Bash tool shell is Git Bash.\n</system-reminder>';
const realUser = '帮我看看这个项目';
const sysMsg = { role: 'system', content: 'You are ZCode, an interactive coding agent' };

const msgs = [
  sysMsg,
  { role: 'user', content: skillsMsg },
  { role: 'user', content: agentsMdMsg },
  { role: 'user', content: planMsg },
  { role: 'user', content: bashMsg },
  { role: 'user', content: realUser },
  { role: 'assistant', content: '好的' },
];

// 极简模式(mode='all',受限期):剥离 skills/AGENTS.md/plan 等注入,但 Bash shell 提示始终保留
const strippedAll = stripInjectedMessages(msgs, 'all');
assert.ok(strippedAll.includes(sysMsg), '主系统提示词应保留');
assert.ok(!strippedAll.some((m) => m.content === skillsMsg), 'skills 注入应被剥离');
assert.ok(!strippedAll.some((m) => m.content === agentsMdMsg), 'AGENTS.md 注入应被剥离');
assert.ok(!strippedAll.some((m) => m.content === planMsg), '极简模式:plan 提示应剥离');
assert.ok(strippedAll.some((m) => m.content === bashMsg), 'Bash shell 提示应始终保留');
assert.ok(strippedAll.some((m) => m.content === realUser), '真实用户消息应保留');
assert.equal(strippedAll.length, msgs.length - 3, '极简模式应剥离 3 条注入(保留 Bash 提示)');

// 解锁后(mode='keep-skills'):保留 skills + Bash 提示,剥离 AGENTS.md/plan
const strippedUnlock = stripInjectedMessages(msgs, 'keep-skills');
assert.ok(strippedUnlock.some((m) => m.content === skillsMsg), '解锁后:skills 注入应保留');
assert.ok(strippedUnlock.some((m) => m.content === bashMsg), '解锁后:Bash shell 提示应保留');
assert.ok(!strippedUnlock.some((m) => m.content === agentsMdMsg), '解锁后:AGENTS.md 注入应剥离');
assert.ok(!strippedUnlock.some((m) => m.content === planMsg), '解锁后:plan 提示应剥离');
assert.equal(strippedUnlock.length, msgs.length - 2, '解锁后应剥离 2 条注入(保留 skills+Bash)');

// 解锁后 + keepAgentsMd=true:AGENTS.md 注入也保留
const strippedUnlockAm = stripInjectedMessages(msgs, 'keep-skills', true);
assert.ok(strippedUnlockAm.some((m) => m.content === skillsMsg), '开关开:skills 保留');
assert.ok(strippedUnlockAm.some((m) => m.content === agentsMdMsg), '开关开:AGENTS.md 保留');
assert.ok(!strippedUnlockAm.some((m) => m.content === planMsg), '开关开:plan 仍剥离');
assert.equal(strippedUnlockAm.length, msgs.length - 1, '开关开:仅剥离 plan 注入');

// 兼容模式(mode='selective'):仅剥离 skills/AGENTS.md,保留 plan/Bash 提示
const strippedSel = stripInjectedMessages(msgs, 'selective');
assert.ok(!strippedSel.some((m) => m.content === skillsMsg), '兼容模式:skills 注入应被剥离');
assert.ok(!strippedSel.some((m) => m.content === agentsMdMsg), '兼容模式:AGENTS.md 注入应被剥离');
assert.ok(strippedSel.some((m) => m.content === planMsg), '兼容模式:plan 提示应保留');
assert.ok(strippedSel.some((m) => m.content === bashMsg), '兼容模式:Bash shell 提示应保留');
assert.equal(strippedSel.length, msgs.length - 2, '兼容模式应剥离 2 条注入');

// ---------- 状态机集成(processBody) ----------
const { processBody } = await import('./server.mjs');

// 场景 A:首轮请求(带全部工具 + 注入)→ 受限,只留 Bash/Read,注入被剥离
const round1 = {
  messages: [
    sysMsg,
    { role: 'user', content: skillsMsg },
    { role: 'user', content: agentsMdMsg },
    { role: 'user', content: realUser },
  ],
  tools: allTools,
};
const rA = processBody(structuredClone(round1));
assert.equal(rA.unlocked, false, '首轮应受限');
assert.deepEqual(rA.parsed.tools.map((t) => t.function.name), ['Bash', 'Read'], '首轮 tools 只剩 Bash/Read');
assert.equal(rA.parsed.messages.length, 2, '首轮 messages 剥离 2 条注入');
assert.equal(rA.parsed.messages[0].content, 'You are a helpful software engineer assistant.', '极简模式:系统提示词应被替换为固定文本');

// 场景 B:第二轮,历史中 assistant 调用了 Bash → 解锁:
//   - 工具全量恢复(46 个)
//   - 系统提示词仍保持 dsh 极简 persona(不被 ZCode 提示词污染)
//   - 仅保留 skills 注入,AGENTS.md 注入被剥离
const round2 = {
  messages: [
    sysMsg,
    { role: 'user', content: skillsMsg },
    { role: 'user', content: agentsMdMsg },
    { role: 'user', content: realUser },
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'tool', content: 'ok' },
  ],
  tools: allTools,
};
const rB = processBody(structuredClone(round2));
assert.equal(rB.isNewUnlock, true, '调用过 Bash 后应触发解锁');
assert.equal(rB.unlocked, true, '解锁后不再受限');
assert.equal(rB.parsed.tools.length, allTools.length, '解锁后工具完整恢复');
assert.equal(rB.parsed.messages[0].content, 'You are a helpful software engineer assistant.', '解锁后:系统提示词仍为极简 persona');
assert.ok(rB.parsed.messages.some((m) => m.content === skillsMsg), '解锁后:skills 注入保留');
assert.ok(!rB.parsed.messages.some((m) => m.content === agentsMdMsg), '解锁后:AGENTS.md 注入剥离');
assert.equal(rB.parsed.messages.length, round2.messages.length - 1, '解锁后仅剥离 AGENTS.md 注入');

// 场景 C:解锁后的后续请求 → 保持解锁且保持同样形态
const rC = processBody(structuredClone(round1));
assert.equal(rC.unlocked, true, '同会话解锁后保持解锁');
assert.equal(rC.parsed.tools.length, allTools.length, '解锁后持续:工具完整');
assert.ok(rC.parsed.messages.some((m) => m.content === skillsMsg), '解锁后持续:skills 注入保留');
assert.equal(rC.parsed.messages[0].content, 'You are a helpful software engineer assistant.', '解锁后持续:系统提示词极简');

// 场景 D:从未调用工具 → 持续受限(同一会话键)
const rD = processBody(structuredClone({
  messages: [sysMsg, { role: 'user', content: '另一个会话的开场' }, { role: 'assistant', content: '回复' }, { role: 'user', content: '继续' }],
  tools: allTools,
}));
assert.equal(rD.unlocked, false, '未调用工具应持续受限');
assert.equal(rD.parsed.messages.length, 4, '无注入消息时 messages 完整保留(system+user+assistant+user)');

// ---------- 工具描述精简(L1 smart 模式) ----------
const { slimTools } = await import('./server.mjs');

const descTools = [
  // 高频防误用 → 完整保留
  { type: 'function', function: { name: 'Bash', description: 'Executes a command in the shell, returning stdout, stderr, and exit code.\n- Working directory persists between calls...', parameters: { properties: { command: { type: 'string', description: 'The command to execute with a very long explanation of what it does' } } } } },
  // 复杂参数工具 → 工具级压成一句,参数描述保留
  { type: 'function', function: { name: 'CronCreate', description: 'Create a persistent scheduled automation in the current workspace. It uses the host\'s real current clock for relative delayMinutes schedules, or a standard 5-field cron expression in the user\'s local timezone for absolute/recurring schedules, and survives app restarts. The prompt must describe the final scheduled work directly and must never ask the run to create another automation.', parameters: { properties: { intervalUnit: { type: 'string', description: 'minute|hourly|daily|weekly|monthly|yearly, must pair with interval' } } } } },
  // 简单工具 → 工具级压成一句,参数描述截断
  { type: 'function', function: { name: 'WebFetch', description: 'Fetches a URL, converts the page to markdown, and answers `prompt` against it using a small fast model. Fails on authenticated/private URLs. HTTP is upgraded to HTTPS. Cross-host redirects are returned to you rather than followed. Responses are cached for 15 minutes per URL.', parameters: { properties: { url: { type: 'string', description: 'The URL to fetch content from (must be a valid absolute URL)' } } } } },
  // MCP → 不动
  { type: 'function', function: { name: 'mcp__imgread__describe_image', description: '聚合描述图片:文本、版面区域、UI 违规、密集测量、美学/风格特征(确定性事实)。', parameters: { properties: { path: { type: 'string', description: '图片路径' } } } } },
  // 未来插件新增的未知工具 → 完整保留(不在任何名单)
  { type: 'function', function: { name: 'future_plugin_tool', description: '这是一个未来插件新增的复杂工具,描述非常长,包含详细的使用说明、参数语义和注意事项,模型需要完整阅读才能正确使用这个工具,不能被精简。', parameters: { properties: { apiKey: { type: 'string', description: 'The API key with a very long explanation about how it should be used and where to get it from the plugin documentation' } } } } },
];

const slimmed = structuredClone(descTools);
slimTools(slimmed);
const byName = (n) => slimmed.find((t) => t.function.name === n).function;

assert.ok(byName('Bash').description.startsWith('Executes a command in the shell'), 'L1:Bash 描述完整保留');
assert.equal(byName('Bash').parameters.properties.command.description.length > 40, true, 'L1:Bash 参数描述保留');
assert.ok(byName('CronCreate').description.length < 150, 'L1:CronCreate 工具级描述压成一句');
assert.equal(byName('CronCreate').parameters.properties.intervalUnit.description, 'minute|hourly|daily|weekly|monthly|yearly, must pair with interval', 'L1:CronCreate 参数描述完整保留');
assert.ok(byName('WebFetch').description.length < 150, 'L1:WebFetch 工具级描述压成一句');
assert.ok(byName('WebFetch').parameters.properties.url.description.length <= 41, 'L1:WebFetch 参数描述截断到 40 字符');
assert.ok(byName('mcp__imgread__describe_image').description.includes('聚合描述图片'), 'L1:MCP 工具描述不动');
assert.ok(byName('future_plugin_tool').description.includes('未来插件新增的复杂工具'), 'L1:未知工具(新增插件)描述完整保留');
assert.equal(byName('future_plugin_tool').parameters.properties.apiKey.description.length > 100, true, 'L1:未知工具参数描述完整保留');

console.log('全部断言通过 ✓ (受限期白名单 / 调用解锁 / 注入剥离 / 状态保持 / L1 精简)');
process.exit(0);
