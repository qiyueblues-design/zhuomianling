# 资源与隐私边界

本仓库用于维护桌宠软件框架。默认不应包含私密配置或受版权限制的角色资源。

## 可以提交

- 源代码。
- 项目文档。
- 小体积示例配置模板。
- `.gitkeep` 等占位文件。
- 明确拥有分发权限的轻量应用图标或素材。

## 不要提交

- API Key、Token、`.env`、`*.local.json` 或云服务密钥。
- 本机绝对路径配置。
- 用户创建的 `pet.local.json`。
- 受版权限制的 Live2D 模型、贴图、动作、表情或头像。
- GPT-SoVITS 声音模型。
- 参考音频。
- `.pth`、`.ckpt`、生成音频和大体积模型产物。
- 构建产物、日志、缓存和依赖目录。

## 本地数据边界

用户数据应保存在 Electron `userData` 中，Windows 上通常是：

```text
%APPDATA%/zhuomianling/
```

开源仓库只保留示例模板：

```text
config/examples/
```

本地调试配置可以放在被忽略的路径中，例如：

```text
config/local/
```

AI API Key 与腾讯云 AppID、SecretId、SecretKey 不写入上述普通 JSON。
它们只由 Electron 主进程通过系统 `safeStorage` 加密后写入：

```text
%APPDATA%/zhuomianling/secure-secrets.json
```

`ai-connections.json` 与 `pets/<pet-id>/pet.local.json` 只保留非敏感元数据和
`hasApiKey` / `hasCredentials` 状态。旧版明文配置会先完成加密回读验证，再由
程序原子移除明文字段；安全存储不可用时必须保留旧数据并停止联网或保存。

渲染进程只能通过 `pet-resource://local/<pet-id>/assets/**` 与
`pet-resource://local/<pet-id>/live2d/**` 读取模型和头像资源。桌宠根目录配置、
`pet.local.json`、`voice/` 和其它本地文件不属于资源协议公开面。

## 受版权限制的角色资源

如果你在自己的电脑上使用某个角色模型进行开发调试，请将它保留为本地桌宠。除非你明确拥有再分发授权，否则不要把角色专属 Live2D 文件、声音模型、参考音频、人设文本或预置台词放回仓库。

公开发布时，默认体验应是一个允许用户导入自己资源的桌宠框架。
