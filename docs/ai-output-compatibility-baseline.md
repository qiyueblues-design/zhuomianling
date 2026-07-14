# AI 输出兼容性基线与阶段 2–6 验证

本文记录阶段 1 冻结时，桌面灵在引入跨供应商安全输出适配器之前的真实链路和测试边界。它用于回归对照，不代表阶段 2 之后的当前实现。

## 阶段 2 完成状态

共享最终回复解析器现已成为非流式响应、流式结束呈现和自动记忆整理的统一边界。它会在 128 KiB 输入预算内剥离 `<think>`/`<analysis>`/`<reasoning>` 与 Markdown 围栏，从混合内容中选择最后一个带有效 `reply` 的完整 JSON，兼容受限的部分 JSON 恢复，并为结果标记 `structured`、`recovered`、`plain-text` 或 `invalid`。无法识别、字段类型非法、只有内部推理或超限的响应会返回受控错误，不再作为最终回复或记忆保存。

## 阶段 3 完成状态

流式信任边界现已前移到主进程。`AiStreamNormalizer` 在与最终解析器一致的 128 KiB 原始输入预算及 32 KiB 可见字段预算内累计供应商内容，跨 chunk 隐藏 reasoning 标签与 Markdown/JSON 外壳，并只通过 IPC 发送安全累计 `reply`、可选 `voiceText`、最终 `emotion` 和解析质量。独立 `reasoning_content`/`reasoning` 字段不会进入标准化器；renderer、字幕、同步揭示和 TTS 均不再接触供应商原始 chunk。超限流会取消真实 reader 并返回受控错误，最后一条没有换行的 SSE data 也会被处理。

## 阶段 4 完成状态

聊天框与字幕继续消费安全累计 `reply` 并保持流式更新；TTS 不再对未定稿的流式 `reply`/`voiceText` 分句，只在 `done` 后选择最终 `voiceText ?? reply` 入队，从而避免朗读随后被重复 JSON 改写的草稿。进入 TTS 前还会拒绝 reasoning 标签、Markdown 围栏、JSON 外壳及结构化字段残片。`emotion` 只在当前宠物确实存在对应映射时采用，否则使用基于安全 `reply` 的通用推断映射，最终回退中性状态。

## 阶段 5 完成状态

AI 连接元数据已升级为 v3，并按规范化 `Base URL + model` 保存输出能力。保存连接和设置页“测试输出”都会使用固定、无用户数据的短对话，依次探测 JSON Schema、JSON Object、兼容文本以及流式/完整回复；探测不经过聊天、TTS 或记忆链路。聊天会按已测能力构造请求，遇到 400/404/415/422 的格式或流式不兼容时有界降级并持久化实际可用能力，401/429/5xx 不会被误重试为格式问题。设置页会展示当前模型的能力状态，地址、密钥或模型变化后自动清除过期显示，并允许重新测试。能力缺失或探测失败时仍保留安全兼容模式。

## 阶段 6 完成状态

跨供应商输出链路已经按主进程解析、renderer 呈现、TTS、记忆、生命周期和旧配置迁移六个边界完成回归。Grok 连续多段 `<think>`、独立 `reasoning_content`/`reasoning`、跨 SSE 分片的 Markdown JSON、重复 JSON、截断与超长内容、连接超时、显式取消、普通文本和 v2 AI 元数据都具有明确测试。所有会进入 renderer 的 AI 内容都是主进程生成的安全标准化字段；TTS 只接受最终安全文本；记忆只接受完整成功后的当前用户文本与最终可见 `reply`。

## 当前链路

1. renderer 根据当前桌宠配置构造 system/persona、最近对话和本轮用户消息。
2. 主进程读取当前宠物的 AI 连接配置，并尝试在 persona 与 conversation 之间注入有界记忆召回结果。
3. 主进程根据当前 `Base URL + model` 的已测能力选择 JSON Schema、JSON Object 或兼容文本，以及流式或完整回复；能力缺失时采用安全兼容默认值。
4. 供应商原始 SSE 只留在主进程。独立 reasoning 字段被丢弃，`AiStreamNormalizer` 隐藏 reasoning 标签、Markdown 和 JSON 外壳，只向 renderer 发送单调增长的安全 `reply`、可选 `voiceText` 与最终 `emotion`。
5. renderer 用安全累计 `reply` 更新聊天框和字幕；TTS 不消费流式草稿，只在 `done` 后读取最终 `voiceText ?? reply`，并再次拒绝内部标签、Markdown 和 JSON 外壳。
6. 主进程先发送 `done`，再对完整且未发生非单调改写的结果异步整理记忆。整理输入只有当前用户文本和最终可见 `reply`，不含原始 chunk、reasoning、system/persona、召回 context、`emotion` 或 `voiceText`。
7. 若结构化格式或流式参数在兼容性状态码下失效，主进程有界降级并回写实际能力；认证、限流和服务端错误直接返回，不伪装为协议不兼容。

## 已有安全与生命周期边界

- AI stream 绑定 `WebContents + petId + requestId + streamId`。
- 替换请求、显式取消、renderer 销毁、连接超时、空闲超时和总超时会中止真实请求/reader。
- 记忆召回失败降级为原聊天请求，不阻断回复。
- 记忆整理不接收 system/persona、召回 context、`emotion` 或 `voiceText`。
- TTS 只在最终 `done` 后以 `voiceText` 为优先来源，同语言场景使用 `reply`。
- 原始供应商 chunk、reasoning 和结构化外壳不得跨越主进程 IPC 边界。
- 已向用户显示的流式前缀不得被后续重复 JSON 改写；发生改写时结果标记为 recovered 且禁止进入记忆。

## 当前兼容范围

| 响应形式 | 当前结果 |
| --- | --- |
| 单个完整 JSON 对象 | 可解析 `reply`、`emotion`、`voiceText` |
| 跨 chunk JSON / Markdown JSON | 主进程逐步提取安全字段，不发送围栏或 JSON key |
| Grok 多段 `<think>` | 全部隐藏，只保留之后的最终回答 |
| 独立 `reasoning_content` / `reasoning` | 忽略，不进入 IPC、TTS 或记忆 |
| 连续或重复 JSON | 最终解析选择最后一个完整有效对象；已显示前缀不允许改写 |
| 纯文本 | 安全流式显示，完整结束后可进入记忆 |
| 部分或截断 JSON | 可受限恢复显示，但标记 recovered 且禁止进入记忆 |
| 超长输入或可见字段 | 取消 reader 并返回受控错误，不发送超限 chunk |
| SSE `delta.content` / `message.content` | 均支持；独立 reasoning 字段不参与内容选择 |
| 仅非流式服务 | 使用完整 JSON 响应，只发送最终 `done` |

## 阶段 6 回归矩阵

| 场景 | 必须保持的结果 | 主要测试 |
| --- | --- | --- |
| Grok 多段 `<think>`、独立 reasoning、分片 Markdown JSON | renderer 只收到安全正文；记忆只保存最终 `reply` | `aiChat.test.ts`、`aiStreamNormalizer.test.ts` |
| 重复 JSON | 最终完整解析取最后有效对象；流式已显示前缀不改写，recovered 不进记忆 | `aiReply.test.ts`、`aiChat.test.ts` |
| 截断 JSON | 可受限显示，`completeForMemory: false` | `aiReply.test.ts`、`aiChat.test.ts` |
| 超长响应 | 取消真实 reader，返回受控错误，不整理记忆 | `aiStreamNormalizer.test.ts`、`aiChat.test.ts` |
| 连接超时、显式取消、owner 销毁 | abort 请求/reader，迟到内容不显示、不整理 | `aiChat.test.ts` |
| 普通文本模型 | 保持流式聊天，最终可见正文可进入记忆 | `aiReply.test.ts`、`aiChat.test.ts` |
| TTS 安全边界 | 只读最终标准化文本，拒绝 think/analysis/reasoning、Markdown 和 JSON 外壳 | `useAiStream.test.ts`、`useVoiceReplyQueue.test.ts` |
| 旧 AI 配置 | 明文密钥安全迁移；v2 无能力字段升级 v3 后仍可用 | `aiSettings.test.ts` |
| 能力探测和运行时降级 | 固定探测不产生记忆；格式/流式有界降级；401/429/5xx 不误重试 | `aiCapabilityProbe.test.ts`、`aiProtocol.test.ts`、`aiChat.test.ts` |

## 验证要求

阶段六交付必须同时通过相关 AI/TTS/记忆边界测试、全量 `npm.cmd test`、`npm.cmd run typecheck`、`git diff --check` 和 `npm.cmd run build`。`build` 包含 renderer 构建、Electron TypeScript 编译及 release 资源审计；不包含 `pack`、`dist:win` 或发布操作。

2026-07-15 阶段六实际验证结果：

- 相关 AI/TTS/记忆边界测试：61 项通过。
- 全量测试：329 项通过，6 项依赖本机集成环境的测试按既有条件跳过。
- TypeScript：renderer 与 Electron 两套 `tsconfig` 均通过。
- 完整构建：Vite production build、Electron TypeScript 编译和 release 资源审计全部通过；资源审计检查 156 个文件。
- 差异格式检查：`git diff --check` 通过。
- `pet.html` 的 `live2dcubismcore.min.js` non-module 信息是仓库已知提示，不影响构建成功；主窗口 `index.html` 未出现该提示。
