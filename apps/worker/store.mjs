import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openStore(storageRoot) {
  mkdirSync(storageRoot, { recursive: true });
  const db = new DatabaseSync(join(storageRoot, 'project.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)');
  const record = db.prepare('SELECT data FROM workspace WHERE id = 1').get();
  const data = record ? JSON.parse(record.data) : { state: null, files: {}, snapshots: {} };
  const save = () => db.prepare('INSERT INTO workspace (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(JSON.stringify(data));
  if (data.state) {
    for (const job of data.state.jobs) if (['queued', 'running'].includes(job.status)) {
      job.status = 'failed'; job.error = '앱 재시작으로 렌더가 중단됐습니다. 다시 실행해 주세요.';
      const version = data.state.versions.find(v => v.id === job.versionId);
      if (version) version.status = 'failed';
    }
    save();
  }
  return { data, save, close: () => db.close() };
}
