# ADR-0001：记忆权威账本使用 Electron 内置 node:sqlite

- 状态：Accepted
- 日期：2026-07-13
- 适用里程碑：M2

## 决策

桌面灵的每宠物权威记忆账本使用目标 Electron 自带的 `node:sqlite`，数据库固定为宠物 `memory/ledger.sqlite3`。账本启用外键、WAL 和 `synchronous=FULL`；全文检索使用同一数据库中的 FTS5。未来 memU SQLite 只作为可删除、可重建的派生索引，不参与权威事务。

数据库由主进程打开，renderer、preload 和 sidecar 均不获得文件路径或连接。所有单宠物 mutation 复用项目的 per-pet 写锁。schema 使用 `memory_meta.schema_version` 显式迁移；迁移前通过 `node:sqlite.backup()` 保存最近有效备份。损坏或未知新版本只抛结构化错误，不自动创建空库覆盖。

## 目标运行时验证

执行：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
.\node_modules\electron\dist\electron.exe scripts\probe-electron-sqlite.cjs
```

2026-07-13 的目标依赖验证结果：Electron 43.0.0、Node 24.17.0、SQLite 3.53.0；文件数据库 WAL、FTS5 查询和在线备份/只读恢复均通过。探针只使用系统临时目录并在结束时删除。

## 后果

- 不新增原生 npm SQLite 依赖，避免 ABI 与 Windows 打包额外资产。
- `DatabaseSync` 的短事务在主进程执行；批量导入和重建必须分批并保持有界，若实测阻塞再迁移到 worker thread。
- 打包资源无需携带独立 SQLite DLL，但构建/打包验证必须继续运行目标 Electron 探针或等价测试。
- FTS5 数据不是独立真源；可从 `memories` 表重建。
