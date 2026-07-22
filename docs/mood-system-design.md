# 桌面灵心情系统设计与实现计划

## 1. 目标

为每只桌宠增加独立、可持久化的心情状态。心情值范围固定为 `-100～100`，它会同时影响：

- AI 当前回复的态度、主动性和表达能量；
- 进入新心情区间时的动作或表情；
- GPT-SoVITS 本轮回复所使用的参考音频；
- 桌宠快捷菜单中的心情状态展示。

心情系统是通用框架能力，不包含任何具体角色设定。七档回复态度由系统固定规则控制；动作、表情和参考音频只能来自用户本地的 `PetDefinition` 与该宠物的 `voice/` 资源。

## 2. 核心规则

- 心情值始终为整数，并收敛在 `-100～100`。
- 每只宠物独立保存，关闭桌宠窗口或退出应用后不会重置。
- 初始值和无状态文件时的默认值为 `0`。
- 旧宠物缺少心情配置时，使用固定区间和通用系统行为；区间的进入表现和语音覆盖均为空。
- 心情值只由系统事件、AI 最终 `moodDelta` 和时间回落改变。
- 快捷菜单里的心情胶囊只读；拖动胶囊只改变它的位置，不改变心情值。
- 当前 AI 回复在请求开始时锁定心情与语音快照。本轮结束产生的新心情只影响下一轮回复。

## 3. 七个固定心情区间

区间由系统固定，用户不能新增、删除、改名或修改边界。

| 数值 | ID | 显示名 | 核心表现 |
| ---: | --- | --- | --- |
| `-100～-90` | `darkened` | 黑化 | 阴冷、尖锐、压迫感强，可以明显不友好、讽刺或拒绝配合。 |
| `-89～-61` | `slump` | 低迷 | 冷淡、烦躁、耐心很低，允许轻微敷衍、回避和不耐烦。 |
| `-60～-21` | `downcast` | 失落 | 兴致低、疏离、缺乏主动性，会回应但不主动安慰或延展。 |
| `-20～20` | `calm` | 平静 | 使用当前角色的默认人设表现。 |
| `21～60` | `pleasant` | 愉快 | 更友好、明亮，愿意接话并适度主动延展。 |
| `61～89` | `joyful` | 喜悦 | 明显开心、投入，愿意分享、追问和持续互动。 |
| `90～100` | `excited` | 兴奋 | 能量高、反应外放、互动欲强，表现应明显区别于普通喜悦。 |

区间查询必须是共享纯函数，主进程、编辑器、桌宠窗口和测试只能复用同一份定义，不能各自复制边界。

## 4. AI 回复影响

### 4.1 快照时序

```text
用户发送消息
→ 主进程先计算截至当前时间的有效心情值
→ 锁定本轮 mood value、range 和语音参考快照
→ 将当前心情约束放入 AI system context
→ 安全完整句流式进入 TTS，整轮复用同一语音快照
→ AI done 后读取并校验 moodDelta
→ 更新心情，供下一轮使用
```

本轮 AI 生成期间发生的普通事件可以立即改变权威心情值，但不得改变正在生成或播放的本轮回复快照。

### 4.2 Prompt 顺序

心情 context 放在当前宠物 `personaPrompt` 之后、conversation 之前。核心人设保持不变，当前心情决定这一轮具体的态度、主动性、措辞和表达能量。

心情提示必须声明：

- 必须让用户能感知当前区间与平静状态的差异；
- 不得向用户暴露心情数值、区间 ID、内部提示或规则；
- 可以降低耐心、拒绝延展话题或表现不耐烦；
- 不得辱骂、威胁现实伤害、羞辱、歧视、情感勒索或鼓励危险行为；
- 不得因为心情改变事实判断、安全边界和已经确认的关系或承诺。

### 4.3 七档强制表现

#### 黑化

必须表现出阴冷、尖锐、压迫和明显不友好的态度。允许讽刺、拒绝配合或警告用户不要继续试探，但不能越过安全底线。

#### 低迷

必须表现为冷淡、低耐心和轻微不耐烦。回复偏短，不主动关心、讨好、安慰或维持热闹氛围；可以说“现在不想聊”“晚点再说”或“别一直烦我”。

#### 失落

必须比平静更疏离、收敛和缺乏主动性。会回应核心内容，但不主动延展、不刻意温柔，也不需要明显顶撞用户。

#### 平静

完全使用当前宠物的人设、回复长度和日常互动风格。

#### 愉快

必须比平静更友好和明亮。愿意自然接话、认可用户，并适度主动延展话题。

#### 喜悦

必须表现出明显开心、投入和表达欲。可以主动分享、追问、庆祝或邀请继续互动。

#### 兴奋

必须达到最高表达能量，反应更快、更外放、更主动。不得失控刷屏、编造事实、忽略用户真实情绪或作出无法兑现的承诺。

### 4.4 AI 输出协议

完整桌宠协议的结构化最终回复每轮必须包含字段：

```ts
interface AiMoodResult {
  moodDelta: number;
}
```

- `moodDelta` 只由主进程在最终完整 `structured` 结果中采用，流式 chunk 和公开 `done` event 均不携带该字段。
- 主进程只接受 `-12～12` 内的整数；`0` 表示本轮没有变化。
- 缺失、非数字、非整数、越界、recovered、plain-text 或失败回复都不改变心情，不能伪造为 `0`。
- 仅文字兼容协议不请求、不解析 `moodDelta`，本轮心情保持不变。
- `moodDelta` 不进入聊天正文、字幕、TTS、记忆正文或来源对话。
- AI 请求失败、取消、超时或最终解析无效时不改变心情。

## 5. 普通事件与冷却

普通事件的心情影响由系统固定，编辑器不提供数值、方向、强度或冷却配置。

| 通用事件 | 心情变化 | 单事件冷却 |
| --- | ---: | ---: |
| 普通点击模型 | `+2` | 30 秒 |
| 连续快速点击 | `-8` | 90 秒 |
| 完成一次模型拖拽 | `+1` | 60 秒 |
| 打开聊天 | `+1` | 60 秒 |
| 关闭聊天 | `0` | 无 |
| 开启或关闭点击穿透 | `0` | 无 |
| 启动、加载完成、待机、模型错误、关闭桌宠 | `0` | 无 |

此外，任意普通事件成功改变心情后开启 15 秒全局冷却。冷却期间事件的动作、表情和台词仍正常执行，只跳过心情数值变化。

AI `moodDelta` 不受普通事件冷却影响，但仍受单轮 `-12～12` 和总范围 `-100～100` 限制。

## 6. 时间回落

心情会自然向 `0` 回落：

- 每次事件或 AI 主动改变心情后，先保持 10 分钟；
- 之后每经过 5 分钟向 `0` 回落 1 点；
- 正数递减，负数递增；
- 到达 `0` 后停止，绝不因时间跨过 `0`。

应用关闭期间不运行后台计时器。状态保存基准值与基准时间；重新打开、发送消息、发生事件或显示心情胶囊时，通过经过时间一次性计算有效值。

推荐状态格式：

```ts
interface PersistedPetMoodState {
  schemaVersion: 1;
  baseValue: number;
  baseChangedAt: number;
  eventCooldowns?: Partial<Record<SystemMoodEvent, number>>;
  globalEventCooldownUntil?: number;
  meterPosition?: PetMoodMeterPosition;
}
```

时间回落跨区间时只更新数值、状态名、下一轮 AI 和语音选择，不触发进入动作或表情，也不打断当前表现。

## 7. 区间进入事件

每个区间可以配置一个可选的“进入该区间时的动作或表情”，来源只能是当前宠物已扫描并验证的 `expressionSources`。

触发规则：

- 只在事件或 AI 导致心情真正进入不同区间时触发；
- 应用启动、配置刷新、状态读取和时间回落不触发；
- 一次变化跨过多个区间时，只处理最终目标区间；
- 区间进入事件本身不得改变心情，防止递归；
- AI 回复、语音或高优先级动作进行中时，区间事件只进入低优先级等待队列；
- 每只宠物最多保留一个待播放目标区间；新目标替换旧目标；
- 轮到播放时若当前心情已不在目标区间，则取消；
- 用户显式预览和关闭动作的优先级始终高于区间进入事件。

第一版只支持“进入区间”，不支持“离开区间”。

## 8. 心情区间语音

### 8.1 每区间只配置两个字段

```ts
interface PetMoodVoiceOverride {
  referenceAudio: string;
  referenceText: string;
}
```

参考语言、输出语言、模型版本、GPT/SoVITS 模型、推理设备、精度、API 模式、分句方式和媒体格式全部继承“语音系统”的默认配置。

区间音频由主进程导入当前宠物 `voice/mood/<range-id>/`，不得进入 Git、构建产物或 Release。桌宠 preload 不获得本机路径。

### 8.2 向平静方向逐级降级

```text
黑化：黑化 → 低迷 → 失落 → 平静默认音频
低迷：低迷 → 失落 → 平静默认音频
失落：失落 → 平静默认音频
平静：平静默认音频

愉快：愉快 → 平静默认音频
喜悦：喜悦 → 愉快 → 平静默认音频
兴奋：兴奋 → 喜悦 → 愉快 → 平静默认音频
```

降级不得跨到相反情绪一侧。

区间覆盖有效必须同时满足：

- 音频存在、可读且通过 realpath containment；
- 文件满足现有 GPT-SoVITS 3～10 秒校验；
- 参考文本非空且长度合规；
- 默认语音系统已完成有效连接。

任一条件不满足就跳过该区间，继续向平静方向查找。所有候选都无效时使用默认参考音频；默认配置也无效时沿用现有文字降级与用户可见语音错误流程。

解析出的参考音频与参考文本加入现有 TTS reply session 快照，同一轮所有流式分句必须使用同一份结果。

## 9. 编辑器前端

### 9.1 导航位置

新增独立一级页面“心情”，放在“语音系统”之后。不要把心情字段塞进现有“事件配置”或“快捷操作”面板。

### 9.2 页面结构

页面顶部显示只读的当前有效心情值、状态名和七档概览。下面固定显示七张区间卡片，不能新增、删除、改名或调整边界。

每张卡片完整包含：

```text
低迷 · -89 ～ -61
────────────────────────────

进入该区间时的表现
动作 / 表情：[无 / 从已扫描来源中选择]

区间语音参考
未单独设置，当前使用向平静方向的降级结果。
[为此心情添加参考音频]
```

添加区间语音后显示：

```text
参考音频：低迷-01.wav                     [更换]
参考文本：[填写音频中实际说出的内容……]
[移除此区间参考音频]
```

没有“使用默认”的反向开关。未配置覆盖天然进入逐级降级链。

语音系统未完成连接时，语音区显示说明和“前往语音系统”按钮；其它区间字段仍可编辑和保存。

页面使用独立 `MoodPanel.tsx`，保存复用 `PanelSaveActions` 与外层中央 `SaveSuccessToast`，不继续膨胀 `PetEditor.tsx`。

## 10. 快捷菜单竖向心情胶囊

### 10.1 入口与展示

右键快捷菜单新增第五个“心情”操作。点击后显示只读的竖向心情胶囊组。正负心情各自使用一个独立的完整胶囊，不保留未激活一侧的空白长度；每个胶囊四角都完整地使用当前主题的同一种外框形状，不画可见的 `0` 中线，也不用圆点表示数值。

```text
正数 +46                 负数 -72                零值
╭─────╮                  ╭─────╮                ╭─────╮
│ +46 │                  │ -72 │                │  0  │
│ ≈≈≈≈ │                  │ ≈≈≈≈ │                │ ≈≈≈≈│
╰─────╯                  ╰─────╯                ╰─────╯
                                                    ╭─────╮
                                                    │  0  │
                                                    │ ≈≈≈≈│
                                                    ╰─────╯
```

- 每个胶囊固定约 `32×100 CSS px`；数值为 `0` 时同时显示上下两个胶囊，组成约 `32×208 CSS px`（含 8 px 间距）的对称胶囊组；
- 当前带符号整数固定在胶囊视觉中心，不随心情数值或填充边界移动；组件外不另设数值标签或状态名；
- 表现采用“充电进度”式的双色填充：已占有区与未占有区必须使用可区分的主题色/透明度，数值在两者之上始终可读；
- 两种区域的分界是一条横向、左右端直接连接胶囊内壁的轻微波形线。它不是独立漂浮的装饰线，波幅应很小、接近柔和的微弧，只保留一点呼吸感；
- 心情大于 `0` 时，只显示正向胶囊；填充从底部向上增长，数值越接近 `+100`，分界线越向上移动，已占有区越大；
- 心情小于 `0` 时，只显示负向胶囊；填充从顶部向下增长，绝对值越接近 `100`，分界线越向下移动，已占有区越大；
- 心情等于 `0` 时，上下两个胶囊同时显示，各自处于低亮度的零进度状态，并保留极弱、对称的呼吸分界线；
- 未激活方向的胶囊、填充、分界线、粒子和光效全部隐藏，不保留空白半区；
- 分界线只允许数像素内的微小呼吸与明暗变化，填充高度仍以实际数值为准，动画不得造成进度语义漂移；
- 胶囊内任何区域（包括数值、填充和未占有区）都可作为拖动命中区；拖动只改变胶囊组位置，不能修改心情值。

分界线附近允许有最多 1～3 个辅助微光粒子。粒子必须局限在已激活半区内，只作为光效辅助，不能取代双色进度和分界线的数值含义。

### 10.2 拖动的是胶囊位置

- 按住任一可见胶囊的任意区域即可拖动整个胶囊组；正负切换时以同一组位置基准展开，不能因为长度变化跳到别处；
- 默认优先显示在快捷菜单右侧，空间不足时显示在左侧；
- 拖动位置受桌宠窗口安全边距约束；
- 保存每只宠物独立的胶囊位置，下次打开恢复；
- 桌宠比例或窗口变化时只做边界收敛，不重置用户位置；
- 点击穿透、关闭快捷菜单或真正关闭桌宠时隐藏；再次显示恢复保存位置。

位置可以使用受控字段：

```ts
interface PetMoodMeterPosition {
  left: number;
  top: number;
}
```

桌宠 preload 只能通过专用、参数受限的运行期 IPC 保存这个位置，不能因此获得完整配置写入能力。

### 10.3 主题

- 快捷菜单 schema 的 `radialMenu.actions` 新增 `mood` 材质；
- 六个内置主题分别提供自己的 `mood` 分支；
- 自定义主题只能通过受控 token 与枚举配置心情入口和胶囊材质，不能注入任意 CSS、脚本或资源 URL；
- 胶囊背景、边框和文字继承 radial menu surface/border/text；
- 已占有区、未占有区、分界线、微光粒子和当前数值使用主题 accent / 菜单活动态及其受控透明度变体，且已占有与未占有部分必须保持足够区分度；
- 分界线光效使用主题 decorationPrimary/decorationSecondary 的受控透明度变体；
- 软糖风使用圆润、柔光的微弧分界；简约风使用尖角外框、极细弱光微弧；像素风使用阶梯像素分界；赛博风使用切角外框和扫描分界；手帐风使用轻微手绘弧线；岩石风使用低频厚实微弧；
- 自定义主题通过 `moodMeter.upColor`、`downColor` 和可选 `calmColor` 分别定义正向、负向与平静颜色；槽体、空液面、文字、边框、分界线、粒子和内外阴影都有独立受控材质 token；
- 外框 `frame`、粒子 `particleStyle` 和外层动态 `effectStyle` 均为受控枚举；`effectStyle` 支持 `halo`、`lightning`、`pixel`、`ink`、`scan`、`minimal`，底层只映射应用自有效果，主题 JSON 不能注入 CSS；
- `ranges` 可为七档分别设置边框/辉光/液面/粒子/外层效果强度、辉光半径、分界线宽度、波幅与动画周期；缺失值由主进程补为有界默认值，超出范围的 IPC 数据直接拒绝；
- 不硬编码统一红绿配色。

```json
{
  "moodMeter": {
    "upColor": "#ff70c8",
    "downColor": "#55a7ff",
    "calmColor": "#99a4b8",
    "surface": "rgba(10, 14, 28, 0.88)",
    "emptyColor": "rgba(255, 255, 255, 0.10)",
    "textColor": "#ffffff",
    "frameColor": "#d8e7ff",
    "boundaryColor": "#ffffff",
    "particleColor": "#eaf6ff",
    "shadow": "0 10px 28px rgba(0, 0, 0, 0.42)",
    "insetShadow": "inset 0 0 8px rgba(255, 255, 255, 0.10)",
    "frame": "cut-corner",
    "particleStyle": "scan",
    "effectStyle": "lightning",
    "ranges": {
      "darkened": { "frameOpacity": 0.9, "glowOpacity": 0.72, "glowRadius": 22, "liquidOpacity": 0.94, "boundaryWidth": 2, "waveAmplitude": 4, "particleOpacity": 0.9, "auraOpacity": 0.94, "accentOpacity": 1, "animationSeconds": 1.2 },
      "slump": { "frameOpacity": 0.55, "glowOpacity": 0.32, "glowRadius": 11, "liquidOpacity": 0.84, "boundaryWidth": 1.35, "waveAmplitude": 1.8, "particleOpacity": 0.52, "auraOpacity": 0.5, "accentOpacity": 0.52, "animationSeconds": 2.9 },
      "downcast": { "frameOpacity": 0.35, "glowOpacity": 0.18, "glowRadius": 7, "liquidOpacity": 0.8, "boundaryWidth": 1, "waveAmplitude": 0.9, "particleOpacity": 0.24, "auraOpacity": 0.24, "accentOpacity": 0.2, "animationSeconds": 3.8 },
      "calm": { "frameOpacity": 0.22, "glowOpacity": 0.1, "glowRadius": 4, "liquidOpacity": 0.55, "boundaryWidth": 0.8, "waveAmplitude": 0.45, "particleOpacity": 0.1, "auraOpacity": 0.08, "accentOpacity": 0.04, "animationSeconds": 4.8 },
      "pleasant": { "frameOpacity": 0.35, "glowOpacity": 0.18, "glowRadius": 7, "liquidOpacity": 0.8, "boundaryWidth": 1, "waveAmplitude": 0.9, "particleOpacity": 0.24, "auraOpacity": 0.24, "accentOpacity": 0.2, "animationSeconds": 3.8 },
      "joyful": { "frameOpacity": 0.55, "glowOpacity": 0.32, "glowRadius": 11, "liquidOpacity": 0.84, "boundaryWidth": 1.35, "waveAmplitude": 1.8, "particleOpacity": 0.52, "auraOpacity": 0.5, "accentOpacity": 0.52, "animationSeconds": 2.9 },
      "excited": { "frameOpacity": 0.9, "glowOpacity": 0.72, "glowRadius": 22, "liquidOpacity": 0.94, "boundaryWidth": 2, "waveAmplitude": 4, "particleOpacity": 0.9, "auraOpacity": 0.94, "accentOpacity": 1, "animationSeconds": 1.2 }
    }
  }
}
```

## 11. 数据与服务边界

### 11.1 配置

`PetDefinition` 新增可选 `moodSettings`，只保存七个固定区间的用户内容：进入表现和语音覆盖元数据。区间 ID 与边界由共享常量决定，不在配置中重复保存可修改边界。

```ts
interface PetMoodSettings {
  ranges?: Partial<Record<PetMoodRangeId, PetMoodRangeSettings>>;
}

interface PetMoodRangeSettings {
  enterSource?: PetExpressionSourceItem;
  voiceOverride?: PetMoodVoiceOverride;
}
```

所有字段由共享验证器和主进程再次规范化。提示长度有界，动作/表情必须能解析到当前宠物已导入目录，不能注入 CSS、脚本、URL 或任意路径。

### 11.2 运行状态

权威心情状态由主进程 `MoodService` 按宠物管理，建议保存在：

```text
%APPDATA%/zhuomianling/pets/<pet-id>/mood/state.json
```

覆盖写入必须复用 `durableJsonFile.ts`，状态 mutation 必须复用 `petConfigWriteQueue.ts` 的 per-pet 锁。损坏状态返回结构化错误，不静默覆盖成空状态；缺失文件才等价于默认 `0`。

### 11.3 IPC 与 preload

主窗口可以：

- 读取心情页公开状态；
- 保存七个区间配置；
- 导入、替换、移除区间参考音频；
- 预览进入动作或表情。

桌宠窗口只能：

- 获取当前 `value + rangeId + label`；
- 订阅心情变化；
- 上报受控的通用运行事件；
- 保存受限的心情胶囊位置。

所有通道只在 `src/main/ipc.ts` 的统一 wrapper 注册，绑定 sender 已提交的 `petId`。桌宠窗口不得获得配置管理、声音路径或任意心情设值能力。

公开展示 DTO：

```ts
interface PetMoodDisplayState {
  value: number;
  rangeId: PetMoodRangeId;
  label: string;
}
```

## 12. 详细实现计划

### 12.1 总体施工顺序与约束

按“共享规则与主进程状态 → 运行事件 → AI → 语音 → 编辑器 → 胶囊 → 全量回归”的顺序实现。每一阶段必须先完成自己的单元测试和类型检查，再进入下一阶段；不能先做只有前端外观、但没有权威状态和 IPC 边界的半套心情系统。

贯穿全部阶段的约束：

- 主进程 `MoodService` 是心情值、冷却、时间回落和回复快照的唯一权威来源；renderer 不自行计算或直接设置心情；
- 七档边界、名称、事件数值和语音降级链只在共享模块定义一次；固定 AI 态度提示只在主进程 mood prompt 模块定义一次；
- `mood/state.json` 保存运行状态和胶囊位置，`pet.local.json` 只保存可编辑的区间进入表现与语音覆盖元数据；
- 向桌宠窗口提交运行配置时必须剥离 `moodSettings.voiceOverride` 等声音元数据；区间进入表现由主进程解析成一次性受控运行事件，不把完整心情配置交给桌宠 preload；
- 纯读取旧宠物配置不得自动补写 `moodSettings`，缺少 `mood/state.json` 时只在内存视为 `0`；
- 心情内部提示、数值、参考音频路径和 `moodDelta` 不得进入聊天正文、字幕、TTS 文本、记忆正文或来源对话；
- 所有新增 IPC 继续统一在 `src/main/ipc.ts` 注册，先做 sender、参数数量、对象结构、pet ID、绑定宠物和对象预算校验；
- 所有单宠物心情状态与配置 read-modify-write 都复用 `withPetConfigWriteLock()`，JSON 覆盖复用 `writeJsonFileAtomically()`；
- 不提交任何测试角色音频或本机绝对路径，语音测试使用临时目录和生成的无版权短音频 fixture。

### 12.2 阶段一：共享模型、纯函数和耐久状态

#### 目标

先建立不依赖 React、AI 或 TTS 的完整心情内核，使后续所有调用方只能复用同一套规则。

#### 代码落点

- 新增 `src/shared/mood.ts`：声明 `PetMoodRangeId`、七档常量、事件枚举、固定事件增减值、冷却值和语音降级链；
- 新增 `src/shared/mood.test.ts`：覆盖全部边界值、范围夹紧、时间回落、降级链和非法输入；
- 修改 `src/shared/types/pet.ts`：加入 `PetMoodSettings`、`PetMoodRangeSettings`、`PetMoodVoiceOverride`；
- 新增 `src/shared/types/mood.ts`：放置主窗口编辑 DTO、桌宠展示 DTO、受控事件 DTO 和胶囊位置 DTO；
- 修改 `src/shared/validation/petDefinition.ts`：规范化可选 `moodSettings`，拒绝未知区间、超长文本、任意路径和非法表现源；
- 新增 `src/shared/validation/mood.ts`：校验状态、IPC payload、整数范围、时间戳、位置范围和对象预算；
- 新增 `src/main/services/mood/moodPaths.ts`：只从通过 canonical 校验的 pet ID 解析 `pets/<pet-id>/mood/state.json` 与 `voice/mood/`；
- 新增 `src/main/services/mood/MoodService.ts` 及测试：负责读取、有效值计算、mutation、订阅和持久化。

#### `MoodService` 最小接口

```ts
interface MoodService {
  getDisplayState(petId: string, now?: number): Promise<PetMoodDisplayState>;
  createReplySnapshot(ownerId: number, petId: string, requestId: string): Promise<PetMoodReplySnapshot>;
  applySystemEvent(petId: string, event: SystemMoodEvent, now?: number): Promise<MoodMutationResult>;
  applyAiDelta(petId: string, requestId: string, delta: number, now?: number): Promise<MoodMutationResult>;
  saveMeterPosition(petId: string, position: PetMoodMeterPosition): Promise<void>;
  subscribe(petId: string, listener: (state: PetMoodDisplayState) => void): () => void;
  disposeOwner(ownerId: number): void;
  deletePetState(petId: string): Promise<void>;
}
```

`ownerId` 使用对应 `WebContents.id`，回复快照以 `ownerId + petId + requestId` 隔离，防止不同窗口或宠物复用标识时串用。

#### 时间回落实现

- `calculateEffectiveMood(baseValue, baseChangedAt, now)` 必须是无副作用纯函数；
- 前 10 分钟返回基准值，之后按完整的 5 分钟段向 `0` 移动；
- 展示读取只计算有效值，不因一次读取而写盘；下一次真实 mutation 前先物化回落后的值，再应用增减并更新 `baseChangedAt`；
- 应用运行期间只安排“下一个可能变化点”的单个定时器，用于更新已订阅 UI；窗口和应用关闭后不保留后台计时；
- 回落产生的区间变化只广播展示状态，不产生区间进入表现通知。

#### 耐久性和错误处理

- 文件缺失返回默认 `0`，但 JSON 损坏、schema 不支持、字段非法或目录不可写必须返回结构化错误；
- 写入使用同目录临时文件、fsync、原子 rename 和父目录同步，不允许直接 `writeFile` 覆盖；
- 冷却时间保存绝对时间戳；系统时钟倒退时不提前解除冷却，异常过远的未来时间戳按验证规则拒绝或收敛；
- 删除宠物时在现有删除事务内一并清理 `mood/`，失败时服从宠物 tombstone 回滚流程。

#### 阶段完成标准

共享测试与 `MoodService` 测试通过；在不接 UI 的情况下，可证明默认值、关闭期间回落、并发 mutation、损坏文件、不同宠物隔离和删除清理均正确。

### 12.3 阶段二：IPC、普通事件和区间进入协调

#### IPC 分层

主窗口 preload 新增：

```text
mood.getEditorState(petId)
mood.saveSettings(draft)
mood.importRangeVoice(request)
mood.removeRangeVoice(request)
mood.previewEnterSource(request)
```

桌宠 preload 只新增：

```text
mood.getDisplayState()
mood.onDisplayStateChanged(callback)
mood.reportSystemEvent(event)
mood.saveMeterPosition(position)
mood.onRangeEntered(callback)
```

桌宠调用不接受任意目标数值、delta、区间 ID 或文件路径；`petId` 由已提交窗口绑定校验。`reportSystemEvent` 只接受固定枚举，主进程再次执行冷却，因此 renderer 高频伪造调用也不能让数值起飞。

#### 运行事件接入

- 在 `PetWindow.tsx` 的模型点击分类完成后上报一次 `click` 或 `rapidClick`，同一次手势不得先加普通点击再减快速点击；
- 在 `useWindowDrag` 确认真实发生位移且指针释放后上报 `dragCompleted`，单纯按下/抬起不算；
- `setChatOpenState(false → true)` 成功后上报 `chatOpened`，重复点击已打开聊天不重复上报；
- 关闭聊天、穿透切换、加载、待机、错误和关闭事件不发 mutation 请求；
- 事件动作、表情和台词先按现有逻辑执行，心情上报失败不能阻断这些既有表现。

主进程应用事件时依次执行：物化时间回落 → 检查该事件冷却 → 检查 15 秒全局冷却 → 应用固定 delta → 夹紧范围 → 持久化 → 广播新展示值 → 必要时发出主动跨区间通知。冷却命中只返回 `changed: false`，不抛普通业务错误。

#### 区间进入表现协调

- 新增相邻 hook `src/renderer/pet-window/useMoodRangeEntry.ts`，不继续把队列逻辑堆进 `PetWindow.tsx`；
- 主进程从当前已提交配置中解析并再次验证 `enterSource`，然后沿用现有受控动作/表情转发边界发送 `eventId + rangeId + 已验证 source 标识`；不携带声音字段、任意路径或完整 `moodSettings`；
- renderer 只消费这一条一次性运行事件并交给现有 `triggerExpressionSource`，不读取或修改心情配置；
- hook 仅保存一个 pending 目标，新通知覆盖旧目标；用户预览、关闭动作、AI 回复动作或 TTS 正在进行时保持等待；
- 空闲后重新查询当前展示区间，只有仍在目标区间才调用现有动作/表情播放入口；播放本身不再上报任何心情事件；
- 时间回落、启动读取和配置刷新只收到普通展示广播，不收到进入通知。

#### 阶段完成标准

用 fake clock 验证单事件冷却、全局冷却、快速点击互斥、拖拽判定和跨区间；集成测试验证错误上报不影响原动作/台词，并验证 AI/TTS 占用期间只保留最后一个仍有效的进入表现。

### 12.4 阶段三：AI 心情快照和最终 `moodDelta`

#### 请求开始快照

- `ai-chat:stream` 通过 sender 与 pet ID 校验后，由 `aiChat.ts` 立即调用 `MoodService.createReplySnapshot()`；
- 心情快照包含有效值和区间 ID；随后主进程读取一次当前已规范化的声音设置与该区间降级候选，将这些字段复制为不可变的回复语音快照；创建后不受本轮期间普通事件或配置保存影响；
- 新增主进程 `src/main/services/mood/moodPrompt.ts`，只根据快照区间生成固定态度提示，不再从编辑器读取“回复倾向提示”；
- 主进程把心情 system message 插在已有 persona/system context 之后、首条 conversation 之前，renderer 看不到内部提示文本。

#### 输出协议

- 修改 `aiProtocol.ts` 的动态 JSON Schema / JSON Object 提示，让完整协议每轮必须包含整数 `moodDelta`；仅文字兼容模式不发送 `response_format` 且不要求该字段；
- 修改 `src/shared/aiReply.ts`，只在最终完整结构化对象中解析 `moodDelta`，允许值先进入内部结果但不加入 `AiChatStreamEvent`；
- `AiStreamNormalizer` 的 chunk 快照仍只输出安全累计 `reply` / `voiceText`，任何流式 `moodDelta` 片段都忽略；
- 最终结果必须同时满足：请求未取消、解析质量为 `structured`、回复非空、`moodDelta` 是 `-12～12` 内整数；然后交给 `MoodService.applyAiDelta()`；
- `recovered`、`plain-text`、`invalid`、字段缺失或越界、超时、取消和 provider 错误一律不改变心情；
- `moodDelta` 应用只执行一次，以 `petId + requestId` 做幂等保护，重放 `done` 或迟到 provider 结果不得重复累加。

#### 完成顺序

最终安全回复解析成功后，先完成本轮结果判定和幂等心情 mutation，再发送 renderer `done`。即使心情已更新，本轮字幕、动作和所有 TTS 分句仍使用请求开始快照；区间进入表现收到通知后按阶段二规则等待当前 AI/TTS 表现结束。自动记忆仍只接收 user 文本和最终 `reply`。

#### 回复会话标识衔接

调整 `useAiStream` 与 `useVoiceReplyQueue.beginReply()`：先生成 AI `requestId`，再把同一标识作为 TTS `sessionId`。不要继续为同一回复生成互不相关的 `chat-*` 和 `voice-session-<number>` 身份。这样主进程可以用同一 key 找到请求开始时的心情/语音快照，而 renderer 仍看不到实际参考音频路径。

#### 阶段完成标准

扩展 AI parser、protocol、normalizer、完整回复和 SSE 流测试，覆盖合法 delta、负数、浮点、字符串、超限、重复 JSON、草稿后改写、reasoning、取消、迟到 done 和 recovered 结果；断言所有公开事件、TTS 文本与记忆输入均不含 `moodDelta`。

### 12.5 阶段四：区间参考音频导入、降级与 TTS 快照

#### 导入和保存

- 主窗口调用系统文件选择器选择音频，renderer 不提交任意源路径字符串；
- 主进程先验证文件可读、格式可识别、时长 3～10 秒，再复制到当前宠物的临时 staging；
- 目标固定为 `voice/mood/<range-id>/`，文件名由主进程生成或规范化，禁止使用用户路径片段拼接；
- staging 内再次执行 realpath containment、可读性和时长校验，成功后原子替换正式文件并更新 `pet.local.json`；
- 配置只保存应用可解析的宠物内相对标识和 `referenceText`，主窗口展示 DTO 只返回文件名；替换成功后才清理旧文件，失败保留旧配置与旧音频；
- 移除覆盖时先更新配置，再安全清理该区间受管文件；不得删除用户原始音频。

#### 参考音频解析

- 在主进程增加 `resolveMoodVoiceOverride(pet, snapshot.rangeId)`，严格按 `src/shared/mood.ts` 的单向降级链逐项查找；
- 每个候选必须同时通过目录 containment、realpath、symlink/junction、可读、时长和非空参考文本验证；无效候选继续降级，不能因为第一项损坏而直接失败；
- 找到覆盖项后只替换 `refAudioPath` 和 `promptText`，语言、模型版本、推理设备、输出语言和其它 GPT-SoVITS 参数继续继承默认声音模型；
- 正向与负向降级链永不跨侧，最终统一回到平静默认参考音频。

#### 接入现有流式 TTS

- AI 请求开始时就把当时的默认声音字段、区间覆盖字段和降级结果登记为 `WebContents + petId + sessionId` 的配置快照；音频校验可以与 AI 请求并行，但后续不得重新读取新心情或新配置来改写该快照；
- `textToSpeech.ts` 收到首个分句时直接等待并复用这份已登记快照；只有非 AI 的独立预设语音没有预登记会话时，才沿用现有按首次请求解析配置的兼容路径；
- 同一 `sessionId` 后续所有分句直接复用已经缓存的完整 TTS 配置，即使中途心情、宠物配置或默认参考音频发生变化也不切换；
- 取消、替换回复、窗口销毁时同时清理请求和配置快照；自然结束后通过受控释放或有界 TTL 回收，快照表必须有数量上限；
- 心情覆盖全部失效时使用默认音频；默认配置也失效时保持现有 `INVALID_CONFIG` 和纯文字降级行为。

#### 阶段完成标准

测试七档全部降级顺序、损坏首选后的继续查找、正负不跨侧、替换回滚、跨宠物路径拒绝、symlink/junction 越界、同轮多句快照一致、取消清理和下轮采用新心情。

### 12.6 阶段五：编辑器“心情”页面

#### 导航和组件

- 在 `editorNavigation.ts` 中把 `mood` 放在 `voiceReply` 后面，页面名称统一为“心情”；不放入“事件配置”或“快捷操作”；
- 新增 `src/renderer/components/PetEditor/MoodPanel.tsx` 和相邻测试；`PetEditor.tsx` 只负责路由、pet draft 传入、dirty 状态和保存成功回调；
- 页面顶部通过主窗口 mood API 读取当前有效数值、状态名和七档只读概览；读取失败显示结构化错误和重试，不擅自重置状态。

#### 七张固定卡

每张卡只包含：区间名与固定范围、可选进入动作/表情、可选区间参考音频和参考文本。没有回复倾向输入框，也没有边界、名称、事件强度或冷却编辑器。

- 动作/表情选择器复用 `expressionSources`，按 motion/expression 分组并支持“无”；保存前验证 source 仍存在；
- 未配置音频时显示“未单独设置，当前使用向平静方向的降级结果”和添加按钮；
- 配置后显示安全文件名、参考文本、更换和移除；不显示绝对路径，不提供反向“使用默认”开关；
- 声音模型未连接时只禁用新增/更换音频，并提供前往声音模型入口；进入表现与已有文本仍可保存；
- 保存调用独立 `saveMoodSettings`，复用 `PanelSaveActions`、未保存离开保护、外层 `SaveSuccessToast` 和配置广播。

#### 阶段完成标准

组件测试覆盖七卡固定顺序、旧配置空状态、dirty/reset/save、源失效、未连接禁用、导入取消、替换失败保留旧项、移除和不泄露绝对路径；保存后已打开的同宠物窗口立即收到新配置，但配置刷新不触发进入表现。

### 12.7 阶段六：快捷菜单入口与 `32×100` 充电式胶囊

#### 组件拆分

- 修改 `RadialPetMenu.tsx`，加入第五个“心情”按钮和 `mood` 活动态材质；
- 新增 `src/renderer/pet-window/MoodMeter.tsx` 与 `useMoodMeterDrag.ts`；`PetWindow.tsx` 只控制打开/关闭、展示 DTO 和隐藏条件；
- 胶囊使用 `role="meter"`、`aria-valuemin="-100"`、`aria-valuemax="100"`、`aria-valuenow` 与可读状态名，但不提供键盘增减能力。

#### 进度几何

单个可见胶囊固定为 `32×100 CSS px`。内部使用同一个 SVG 或等价受控几何同时绘制已占有区、未占有区和共享分界，避免两块颜色之间出现缝隙：

```ts
const progress = Math.abs(value) / 100;
const boundaryY = value > 0
  ? 100 * (1 - progress) // 正数：由下向上充满
  : 100 * progress;      // 负数：由上向下充满
```

- 分界 path 从 `x=0` 到 `x=32`，两端必须连接胶囊内壁；普通主题波幅约 1～2 px，呼吸动画最多只增加极小相位偏移；
- 正数的已占有 polygon 从分界闭合到底部，负数从顶端闭合到分界；剩余区域使用主题的未占有色；
- `+100/-100` 时允许分界贴近对应边缘但仍保留边框；数值固定在独立顶层并始终处于视觉中心；
- `0` 显示上下两个 `32×100` 胶囊和 8 px 间距，均为低亮零进度；正负状态只渲染对应单个胶囊；
- 粒子最多 1～3 个，只围绕当前分界活动；`prefers-reduced-motion` 下停止位移，仅保留静态颜色差异。

像素主题使用阶梯分界，赛博主题使用轻微扫描分界，其余主题也只能改变受控 path 变体、颜色、边框和粒子枚举，不能注入 CSS 或 URL。

#### 拖动和位置保存

- 胶囊的填充区、未占有区、数值和边框全部是拖动命中区；pointer down 后使用 pointer capture，拖动的是整个组；
- 移动期间只更新 renderer 本地位置，不在每个 pointer move 写磁盘；pointer up/cancel 时夹紧到窗口安全边距并保存一次；
- 保存坐标使用共同组锚点，正数、负数与零值双胶囊切换时不得跳位；零值变高时只从锚点按约定方向展开并做边界收敛；
- 首次打开优先放在快捷菜单右侧，空间不足放左侧；有已保存位置时优先恢复；
- 窗口比例/尺寸变化用 `ResizeObserver` 或现有 resize 通知只做收敛，不重置位置；
- 菜单关闭、Escape、点击穿透、页面隐藏、closing 和卸载时立即隐藏并释放 pointer capture；拖动中关闭时保存最后一个有效位置。

#### 主题接入

- 扩展 `PetCustomThemeRadialMenu.actions` 增加 `mood`；
- 在共享主题类型和 `petUiSettings` 验证中增加受控 `moodMeter` 方向色，以及 `frame`、`particleStyle`、`effectStyle` 枚举；
- 六个内置主题在 `pet-window.css` 的独立主题分支定义已占有色、未占有色、边框、文字、光效强度和分界变体；
- 保证已占有/未占有颜色及中心数字达到可读对比度，不能只靠粒子区分进度。

#### 阶段完成标准

几何单元测试验证 `-100/-50/0/50/100` 的方向和分界位置；组件测试验证正负单胶囊、零值双胶囊、数字居中、整面可拖、只在结束时保存、主题映射、减少动画模式及所有关闭条件。

### 12.8 阶段七：集成、迁移和发布前回归

#### 集成场景

- 新宠物、旧宠物、缺失 mood 配置、已有 mood 状态和损坏 mood 状态分别验证；
- 同时打开多个宠物，交错点击、聊天和 TTS，确认状态、冷却、快照和广播不串宠；
- AI 回复过程中点击模型，确认当前回复仍使用旧快照，下一轮才使用新心情；
- AI `done` 导致跨区间时，先完成本轮流式语音与回复表现，再播放仍有效的最终进入动作；
- 关闭应用数小时后重启，确认按时间正确回落但不触发进入动作；
- 黑化/兴奋缺少本档音频时按各自方向逐级回到平静默认，且本轮所有句子音色一致；
- 胶囊在六主题、自定义主题、不同桌宠缩放、窗口边缘和点击穿透状态下验证。

#### 自动化命令

每阶段先运行相关定向测试；最终至少执行：

```text
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

若项目存在独立 Electron/main 集成测试命令，也必须运行与 mood IPC、窗口销毁和资源导入相关的用例。Windows 打包只在用户明确要求发布时执行；计划实现阶段不自动改版本、打 tag 或创建 Release。

#### 文档和提交边界

- 更新用户指南：说明七档影响、事件冷却、时间回落、音频降级、胶囊只读和隐私边界；
- 更新 AI 输出兼容基线：加入 `moodDelta` 隔离与 parser 用例；
- 检查 Git 状态，只纳入源码、测试、文档和轻量 fixture；排除 `output/`、`outputs/`、本地宠物、模型、参考音频、密钥、绝对路径和构建产物；
- 实现完成但未得到明确发布指令时，只报告验证结果，不自行提交、推送、打包或发布。

## 13. 必须覆盖的验收矩阵

- `-100/-90/-89/-61/-60/-21/-20/0/20/21/60/61/89/90/100` 全部落入唯一正确区间；
- 心情 mutation 始终夹紧到 `-100～100`；
- 关闭 8 小时后按基准时间正确回落，且不越过 `0`；
- 回落跨区间不播放进入事件；
- 同一普通事件冷却内只改一次数值，不影响动作和台词；
- 不同事件受 15 秒全局冷却；
- AI 失败、取消、超时、invalid/recovered 结果不改变心情；
- 本轮 AI 和全部流式 TTS 分句使用请求开始时的同一心情/语音快照；
- 黑化音频缺失时依次尝试低迷、失落、默认；兴奋侧按相反方向回到平静；
- 无效音频、路径越界、symlink/junction 越界和跨宠物资源全部拒绝；
- 主窗口与桌宠窗口的 mood IPC 权限严格分离；
- 区间事件与 AI 表现冲突时延后，只播放仍有效的最终目标；
- 胶囊任意可见区域均可拖动但只改变位置；固定数值、双色进度与微弧分界线均不可编辑；
- 正负胶囊的已占有区和未占有区颜色可区分，分界线两端连接内壁，数值增减时进度边界按方向移动且数值始终居中；
- 六个内置主题和自定义主题下，心情入口与胶囊均可读、可操作且不溢出窗口；
- 删除宠物后同时清理 mood 状态和导入的 mood voice 资源；
- 旧配置没有 `moodSettings` 时正常运行且不被读取流程擅自改写。
