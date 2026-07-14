const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhuomianling-sqlite-probe-"));
  const databasePath = path.join(root, "probe.sqlite3");
  const backupPath = path.join(root, "probe.sqlite3.bak");
  let database;

  try {
    database = new DatabaseSync(databasePath);
    const journalMode = database.prepare("PRAGMA journal_mode = WAL").get().journal_mode;
    database.exec("CREATE VIRTUAL TABLE probe_fts USING fts5(content)");
    database.prepare("INSERT INTO probe_fts(content) VALUES (?)").run("desktop pet memory");
    const matchCount = database
      .prepare("SELECT count(*) AS count FROM probe_fts WHERE probe_fts MATCH ?")
      .get("memory").count;
    database.exec("CREATE VIRTUAL TABLE probe_trigram USING fts5(content, tokenize='trigram')");
    database.prepare("INSERT INTO probe_trigram(content) VALUES (?)").run("用户喜欢喝咖啡");
    const trigramMatchCount = database
      .prepare("SELECT count(*) AS count FROM probe_trigram WHERE probe_trigram MATCH ?")
      .get('"喜欢喝"').count;
    const sqliteVersion = database.prepare("SELECT sqlite_version() AS version").get().version;
    await backup(database, backupPath);
    database.close();
    database = undefined;

    const restored = new DatabaseSync(backupPath, { readOnly: true });
    const backupCount = restored.prepare("SELECT count(*) AS count FROM probe_fts").get().count;
    restored.close();

    process.stdout.write(
      `${JSON.stringify({
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        sqliteVersion,
        journalMode,
        fts5: matchCount === 1,
        fts5Trigram: trigramMatchCount === 1,
        backup: backupCount === 1
      })}\n`
    );
  } finally {
    database?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
