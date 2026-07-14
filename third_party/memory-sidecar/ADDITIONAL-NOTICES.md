# 记忆运行时补充声明

正式记忆运行时包含下列 wheel 包，但这些包发布的 wheel 元数据中没有独立的
许可证文件。生成的 `package-inventory.json` 会保留包名、版本、作者或仓库
元数据以及声明的许可证。对应的标准许可证原文随本声明一起放在安装包的
`third-party-licenses/standards/` 目录中。

| 软件包 | 版本 | 声明的许可证 | 上游仓库 |
| --- | --- | --- | --- |
| langchain-core | 1.4.9 | MIT | https://github.com/langchain-ai/langchain |
| langsmith | 0.10.2 | MIT | https://github.com/langchain-ai/langsmith-sdk |
| loguru | 0.7.3 | MIT | https://github.com/Delgan/loguru |
| orderly-set | 5.5.0 | MIT | https://github.com/seperman/orderly-set |
| tqdm | 4.68.4 | MPL-2.0 AND MIT | https://github.com/tqdm/tqdm |
| flatbuffers | 25.12.19 | Apache-2.0 | https://github.com/google/flatbuffers |
| onnxruntime | 1.27.0 | MIT | https://github.com/microsoft/onnxruntime |
| tokenizers | 0.23.1 | Apache-2.0 | https://github.com/huggingface/tokenizers |

## BAAI/bge-small-zh-v1.5

安装包中的 INT8 ONNX 文件由本项目从固定的官方
`BAAI/bge-small-zh-v1.5` revision
`7999e1d3359715c523056ef9478215996d62a620` 自行生成；其模型卡声明采用 MIT
许可证。开发阶段使用的第三方 Xenova 转换文件不会进入发布包。生成的模型
清单会保留官方源文件哈希、转换工具链版本和最终 ONNX 哈希。

Copyright (c) Beijing Academy of Artificial Intelligence (BAAI) and model
contributors. 适用的 MIT 许可证原文位于
`third-party-licenses/standards/MIT.txt`。

## Python

安装包中的 CPython 3.13 embeddable runtime 来自 python.org。其原始
`LICENSE.txt` 保留在 `runtime/` 内，并另行复制到第三方许可证目录。
