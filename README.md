# ZCode Tool Gate

> 会话「调用工具前」对齐 DeepSeek Harness 极简模式;调用白名单工具后自动解锁完整工具链的本地透明代理。

一个**零依赖、单文件**的本地 HTTP 透明代理,为 ZCode(及其他 OpenAI 兼容客户端)提供两阶段工具暴露策略:

1. **受限期**:只暴露极简工具集(默认 `Bash`/`Read`),系统提示词压缩为一句固定 persona,剥离全部运行时上下文注入——思维链零污染,对应 DeepSeek Harness 的 `minimal` preset 工作流。
2. **解锁后**:一旦模型真正调用过白名单工具,下一轮请求起自动恢复**完整工具链**(系统工具 + 全部 MCP 工具)+ skills 注入,而系统提示词**仍然保持极简**——思维不被行为准则/规则文本重新污染。

## 特性

- 🪶 **零依赖**:仅需 Node.js 18+(自带 `fetch`),无任何 npm 包,单文件部署
- 🔄 **双上游快捷切换**:内置 `opencode`(Opencode Go 网关)与 `deepseek`(DeepSeek 官方)两个选项,也支持任意 OpenAI 兼容端点
- 🧠 **极简思维模式**:受限期系统提示词固定为 `You are a helpful software engineer assistant.`(对应 dsh 极简模式 persona `complete: true` / `includeRuntimeContext: false`)
- 🔓 **渐进解锁**:模型调用过白名单工具(默认 Bash/Read)后自动解锁,无需人工干预
- 🧹 **注入过滤**:受限期剥离全部 `<system-reminder>` 注入(保留 Bash shell 提示);解锁后仅保留 skills 注入
- ✂️ **工具描述精简(可选)**:`TOOL_DESC_MODE=smart` 按名单压缩方法论型描述(实测省 33% 前缀),未知工具/插件新增工具自动完整保留
- 🔐 **不接触密钥**:Authorization 头由客户端发出、代理原样转发,代理不存储任何凭据
- 📦 **不绑定工具清单**:新会话新增的 MCP / 插件工具自动透传,无需改代理

## 工作原理

```
ZCode ──→ 本地代理(127.0.0.1:8788) ──→ 上游(opencode / deepseek / 自定义)
                │
                ├─ 受限期(会话未调用过白名单工具)
                │    • 系统提示词 → 固定极简 persona
                │    • 注入 → 全部剥离(保留 Bash shell 提示)
                │    • tools → 仅白名单(Bash, Read)
                │
                └─ 解锁后(历史出现 assistant.tool_calls 含白名单工具名)
                     • 系统提示词 → 仍为极简 persona(思维不被污染)
                     • 注入 → 仅保留 skills
                     • tools → 完整恢复(含全部 MCP 工具)
```

**会话键**:第一条非注入 user 消息的 SHA-1,用于区分会话;上下文压缩(compact)请求不会被误判。

**设计动机**:受限期让模型用极简思维证明自己能主动调用工具;解锁后保持极简 persona,只把「工具与技能」交还给模型,避免全量提示词(行为准则、安全边界、规则注入)重新污染思维链。参考 [DeepSeek Harness](https://github.com/deepseek-ai) `config/agent-presets/minimal` 的设计——提示词只给身份,规则交给机制。

## 快速开始

### 1. 选择上游并启动

编辑 `config.json`:

```json
{
  "port": 8788,
  "upstream": "opencode"
}
```

- `"opencode"` → `https://opencode.ai/zen/go/v1`
- `"deepseek"` → `https://api.deepseek.com`(需在客户端配置 DeepSeek 官方 API Key)
- `"https://你的网关地址"` → 任意 OpenAI 兼容端点

启动:

```bash
# Windows
start.bat

# Linux / macOS
./start.sh

# 临时指定上游(参数优先级高于 config.json)
start.bat deepseek
```

看到 `ZCode 工具链渐进解锁代理已启动` 即成功。

### 2. 在客户端中添加模型

以 ZCode 为例:

- 类型:**OpenAI 兼容**(openai-compatible)
- Base URL:`http://127.0.0.1:8788`
- API Key:填上游要求的密钥(代理透传)
- 模型:按上游支持的模型 id 填写

> 切换模型后请**新开一个会话**(旧会话历史可能已含工具调用,不满足受限期判定)。

### 3. 验证

浏览器打开 `http://127.0.0.1:8788/status`:

```json
{
  "status": "ok",
  "upstream": "https://opencode.ai/zen/go/v1",
  "firstRoundTools": ["Bash", "Read"],
  "minimalSystemPrompt": "You are a helpful software engineer assistant.",
  "unlockKeepMinimal": true,
  "unlockKeepSkills": true,
  "toolDescMode": "full",
  "restricted": 0,
  "unlocked": 0
}
```

代理日志中:受限期请求显示 `状态=受限(Bash/Read)`,调用过白名单工具后 `状态=解锁`,之后为 `状态=已解锁`。

## 配置参考

优先级:**环境变量 > config.json > 默认值**。

| config.json | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `port` | `PORT` | `8788` | 监听端口 |
| `upstream` | `UPSTREAM_BASE_URL` | `opencode` | `opencode` / `deepseek` / 完整 URL |
| `firstRoundTools` | `FIRST_ROUND_TOOLS` | `["Bash","Read"]` | 受限期工具白名单;`[]` 或 `none` 表示完全无工具 |
| `minimalSystemPrompt` | `MINIMAL_SYSTEM_PROMPT` | `You are a helpful software engineer assistant.` | 受限期系统提示词;空串=保留客户端原始提示词 |
| `stripInjections` | `STRIP_INJECTIONS` | `true` | 是否剥离 `<system-reminder>` 注入 |
| `enableUnlock` | `ENABLE_UNLOCK` | `true` | `false` 时永远受限 |
| `unlockKeepMinimal` | `UNLOCK_KEEP_MINIMAL` | `true` | 解锁后系统提示词仍保持极简;`false` 恢复客户端原始提示词 |
| `unlockKeepSkills` | `UNLOCK_KEEP_SKILLS` | `true` | 解锁后保留 skills 注入;`false` 完全透传 |
| `toolDescMode` | `TOOL_DESC_MODE` | `full` | 解锁后工具描述策略:`full` 原样 / `smart` 名单式精简 |
| — | `DUMP_DIR` | 关闭 | 调试转储:转发给上游的请求体(JSON 美化)写入该目录 |
| — | `LOG_FILE` | 关闭 | 日志文件路径 |

### `toolDescMode=smart`(L1 精简)规则

| 类别 | 工具 | 处理 |
|---|---|---|
| 高频防误用 | `Bash` `Read` `Write` `Edit` `Skill` | 描述完整保留 |
| 复杂参数 | `Cron*` `AskUserQuestion` `Agent` `EnterPlanMode` `ExitPlanMode` | 描述压成一句,**参数描述保留** |
| 简单工具 | `WebFetch` `Todo*` `TaskOutput` `TaskStop` `SendMessage` `ReadSessionContext` `mcp__node_repl__js*` | 描述压成一句,参数描述截断 40 字符 |
| 其他(含未来插件新增) | 任何未列出的工具 | **完整保留,不受影响** |

## 测试

```bash
node test.mjs       # 逻辑单元测试(会话键/解锁判定/注入过滤/极简提示词/L1 精简)
node test_e2e.mjs   # 本地端到端测试(不触网,PROXY_PORT 可改端口避免冲突)
```

## 安全说明

- 代理**不存储任何密钥**:Authorization 头由客户端发出、代理原样转发。
- 日志只记录方法、路径、状态码与受限/解锁计数,默认不记录请求体;调试可开 `DUMP_DIR`(注意:转储含完整对话内容,勿外传)。
- 上游为第三方服务时,对话内容会经其处理,请自行评估数据合规。

## 已知局限

- 受限期内模型尝试调用被剥离的工具会直接失败(工具不存在)——这是预期行为,正是「只能先调用白名单工具才能解锁」的机制。
- 注入识别依赖客户端 `<system-reminder>` 模板(`The following skills are available for use` / `# agentsMd`);若客户端改版模板,需同步 `server.mjs` 中的正则。
- 代理重启会清空解锁状态,重启后建议新开会话。
- 不同会话若首条真实用户消息完全相同会共享会话键(罕见,可核对日志)。

## 常见问题

**Q: 解锁后模型不知道我的 AGENTS.md 规则了?**
A: 设计如此——AGENTS.md 与 plan 提示等注入在解锁后仍被过滤,以保持思维链干净。如确需恢复,将 `unlockKeepMinimal` / `unlockKeepSkills` 设为 `false` 可退回「完全透传」。

**Q: 新增的 MCP / 插件工具能用吗?**
A: 能。代理不绑定工具清单,新工具由客户端自动加入请求,解锁后原样透传;`smart` 精简模式下未列出的工具也自动完整保留。

**Q: 切换模型需要重启代理吗?**
A: 不需要。代理与模型无关,`model` 字段原样透传;切换后新开会话即可。

## 许可证

MIT © 2026
