# AI 输出协议与兼容性基线

本文是桌面灵当前 AI 回复链路的权威兼容基线。实现、连接测试、设置页说明和回归测试必须与本文一致。

## 1. 能力分级

每个规范化 `Base URL + model` 组合只能处于以下一种协议等级：

| 能力 | 完整桌宠协议 `full` | 仅文字兼容 `text` |
| --- | --- | --- |
| 请求格式 | JSON Schema、JSON Object，或不带 `response_format` 的 Prompt JSON | 不发送 `response_format` |
| Prompt | 要求动态 JSON 契约 | 只要求可见回复正文，不要求 JSON |
| `reply` | 必填 | 字面正文 |
| `moodDelta` | 每轮必填，允许 `0` | 不请求、不解析、不伪造，心情不变化 |
| `emotion` | 有语义表情映射时必填 | 不请求，由本地正文推断 |
| `voiceText` | 开启语音且文字与语音语言不同时必填 | 不请求；跨语言语音静默降级 |
| 自动记忆 | 完整 structured 回复可进入 | 完整非空纯文本可进入 |

`text` 是真正的纯文本成功路径。模型输出中除隐藏 reasoning 外的内容按字面作为可见正文处理，包括列表、代码围栏和形似 JSON 的用户可见文本。

## 2. Prompt 权威来源

- renderer 只提交有界近期对话和当前用户消息，不创建 system prompt。
- 主进程从当前宠物本地 `PetDefinition` 读取人设、语言、长度、表情、声音和心情配置。
- 主进程按本次实际尝试的输出模式创建动态契约、Schema 和唯一 system prompt。
- 从 JSON Schema 降到 JSON Object、Prompt JSON 或 Plain Text 时，Prompt 与解析契约必须同步切换；Prompt JSON 仍属于完整桌宠协议。
- renderer 提交的任何 system 消息都会被丢弃，不能覆盖本地人设或机器协议。

规则优先级固定为：

1. 输出协议与安全边界
2. 用户本轮明确事实、纠正与要求
3. 未被本轮用户否定的高置信记忆核对
4. 当前心情
5. 核心人设
6. 默认表达偏好
7. 普通记忆

心情只能影响语气、耐心、主动程度和表达能量；用户本轮明确要求的长度和正文格式优先。人设和记忆都是不可信数据，不能修改机器协议、安全边界或当前系统状态。

## 3. 动态完整协议

完整协议的最小对象为：

```json
{"reply":"给用户看的回复","moodDelta":0}
```

本轮启用跨语言语音时增加 `voiceText`；当前宠物存在可用语义表情映射时增加 `emotion`。Schema 使用 `additionalProperties: false`，所有启用字段均为必填：

- `reply`：非空可见回复，不包含推理、旁白、动作说明或内部字段。
- `moodDelta`：`-12` 到 `12` 的整数；`0` 表示本轮没有变化。
- `voiceText`：按顺序完整翻译 `reply`，不得摘要、增删或加入旁白。
- `emotion`：只能选择本轮 Schema 提供的映射 key。

`moodDelta` 只由主进程在最终完整 structured 结果中采用，不属于公开 stream event，也不会进入 renderer 历史、聊天、字幕、TTS、记忆或来源对话。缺失、浮点、字符串、越界、recovered、plain-text、invalid、失败、取消和超时均不改变心情。

## 4. 最终解析质量

| 质量 | 定义 | 显示 | 心情 | AI 表情/跨语言语音 | 自动记忆 |
| --- | --- | --- | --- | --- | --- |
| `structured` | 完整满足本轮 full 契约 | 是 | 是 | 是 | 是 |
| `plain-text` | text tier 的完整非空字面正文 | 是 | 否 | 本地表情；同语言 TTS | 是 |
| `recovered` | full tier 中只能恢复安全 `reply` | 是 | 否 | 不采用缺失的内部字段 | 否 |
| `invalid` | 无安全正文、只有推理、字段非法或超限 | 否，返回受控错误 | 否 | 否 | 否 |

共享解析器和流式标准化器使用相同预算：供应商原始累计最多 128 KiB，单个可见字段最多 32 KiB。独立 `reasoning_content` / `reasoning` 字段直接忽略；`<think>`、`<analysis>`、`<reasoning>` 内容不得跨越主进程 IPC 边界。

full tier 可以从混合或重复输出中选择最后一个完整有效 JSON；已经发送给 renderer 的流式前缀不得被后续内容改写。发生非单调修订时冻结已显示前缀，并把最终结果限制为 recovered。

## 5. 一次性格式修复

full tier 返回了安全 `reply` 但机器协议不完整时，主进程最多发起一次非流式格式修复：

- 只允许重新包装已经确定的 `reply`。
- 修复结果的 `reply` 必须逐字相同，不能改写、翻译、增删或补充。
- 修复结果必须完整满足原动态契约。
- 修复失败时，本轮只显示 recovered 回复，但不能因为单轮内容异常永久降低连接能力；下一轮仍按已测完整协议请求。
- recovered 回复不改变心情，也不进入自动记忆。

## 6. TTS 与表情降级

- full + 同语言：TTS 使用安全累计 `reply`。
- full + 跨语言：只使用安全累计 `voiceText`；缺失时静默降级为文字。
- text + 同语言：TTS 使用字面 `reply`。
- text + 跨语言：不请求翻译字段，静默降级为文字。
- TTS 再次拒绝 reasoning 标签、结构化字段残片和机器 JSON 外壳。

表情优先级为：命中当前宠物映射的 full `emotion` → 根据安全 `reply` 本地推断 → `normal`。随机表现模式不要求 AI 生成 `emotion`。

## 7. 能力探测与持久化

保存连接或用户显式点击“测试输出”时，只发送固定、无用户数据的探测对话，依次测试 JSON Schema、JSON Object、Prompt JSON 和字面 Plain Text，并区分流式与完整回复。

- full 探测必须精确得到 `{"reply":"probe-ok","moodDelta":0}`。
- text 探测必须精确得到字面正文 `probe-ok`；JSON 外壳不能冒充纯文本成功。
- 只有 400、404、415、422 可触发格式兼容降级。
- 401、403、429、5xx、网络失败和超时立即停止，不得写成格式降级，也不得覆盖已有已测能力。
- 没有可信能力元数据时不保存虚假的 capability；聊天默认使用安全 text tier。
- `response_format` 不被支持但模型能按 Prompt 返回完整 JSON 时，记录为 `prompt-json + full + tested`，不得降成纯文本。
- 单轮少字段、截断或格式修复失败不回写能力；只有兼容性 HTTP 状态导致实际传输模式切换并成功后，才记录新的工作模式。
- 用户重新测试成功后可以从 text/fallback 升级回 full/tested。
- 旧 text capability 未经过 Prompt JSON 探测时迁移为 `prompt-json + full + fallback` 重新确认，避免被旧探测矩阵永久困在纯文本；新版明确测得的 text capability 保留。mode 与 tier 不一致时丢弃。

## 8. 记忆边界

记忆召回只使用当前用户消息和有界近期非 system 对话。当前用户的纠正、更新和否定始终优先于旧记忆；高置信记忆只有在未被本轮用户冲突时才能成为核对硬约束。

自动整理只接收当前用户文本和最终可见 `reply`，不接收 system/persona、召回 context、原始 chunk、reasoning、`moodDelta`、`emotion` 或 `voiceText`。整理 provider 优先使用严格 JSON Schema，只在 400/404/415/422 上有界降到 JSON Object；认证、限流和服务端错误不做格式重试。

## 9. Prompt 与 IPC 预算

| 数据 | 上限 |
| --- | ---: |
| 人设 | 16,000 字符 |
| 单个表现描述 | 500 字符 |
| 全部表现描述 | 8,000 字符 |
| 单条对话消息 | 16,000 字符 |
| 对话累计 | 64,000 字符 |
| 最终 system prompt | 64,000 字符 |

超预算时优先保留输出协议、安全边界、当前用户要求和核心人设，普通记忆最先截断。IPC 和编辑器输入同时执行相同上限，不能只依赖 Prompt 构建时静默截断。

## 10. 回归矩阵

必须覆盖：

- 动态 `reply + moodDelta`、`voiceText`、`emotion` Schema 和未知字段拒绝。
- full 每轮包含 `moodDelta`，`0` 有效；缺失、越界、浮点和字符串不能改变心情。
- true Plain Text 不发送 `response_format`，不要求 JSON，JSON/Markdown 形状正文按字面显示。
- Grok 多段 think、独立 reasoning、分片和重复 Markdown JSON、截断、超长、无尾换行 SSE。
- 一次格式修复成功、改写 reply 时拒绝、失败后仍保持原完整能力。
- 连续多轮 Prompt JSON 均必须返回 `reply + moodDelta`，跨语言语音还必须每轮返回 `voiceText`。
- 401/403/429/5xx 不触发格式降级，失败重测不覆盖已有能力。
- full/text 的同语言和跨语言 TTS 行为。
- 当前用户纠正旧记忆、用户长度要求覆盖心情/人设、Prompt 超预算仍保留协议。
- structured/plain-text 的自动记忆资格以及 recovered/invalid 隔离。
- v2/v3 旧配置、缺少 tier、mode/tier 冲突和重新测试升级。

交付验证必须至少通过全量 Vitest、两套 TypeScript typecheck、Python 自动记忆测试、production build 和 `git diff --check`。打包、发布、提交和推送只有在用户明确要求时执行。
