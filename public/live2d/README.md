# Live2D 公开静态资源目录

这里仅用于放置开发调试或可公开分发的 Live2D 静态资源包。Vite 会将 `public/` 下的文件原样复制到构建产物中，渲染进程可以通过根路径访问。

注意：这里不是放项目调用脚本的地方。Live2D 的加载和控制代码位于 `src/renderer/live2d/`；本目录中的 `.model3.json` 是 Live2D 模型入口描述文件，用来指向 `.moc3`、贴图、动作、表情和物理文件。

用户在前端导入 Live2D 模型后，模型不会复制到本目录。当前导入链路会把模型资源复制到 Electron 本机用户数据目录：

```text
userData/
  pets/
    <pet-id>/
      live2d/
      pet.local.json
```

导入成功后，`pet.local.json` 中的 `modelPath` 会保存为受控的 `pet-resource://...` 资源地址，由主进程资源协议暴露给渲染进程加载。

推荐结构：

```text
public/live2d/
  pet-id/
    *.model3.json
    *.moc3
    *.physics3.json
    *.motion3.json
    *.exp3.json
    textures/
```

开发调试时，模型路径可写成：

```text
live2d/pet-id/web.model3.json
```

正式用户流程不要依赖仓库内置资源；用户真实导入的 Live2D 模型以 `userData/pets/<pet-id>/live2d/` 为准。

模型文件通常较大，且可能包含受版权或授权限制的内容。默认不要提交真实模型、贴图、动作、参考音频或其他未确认授权的资源到 git。
