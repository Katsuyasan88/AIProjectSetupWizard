// テスト補助: temp 内だけで作業する。ネットワーク・課金なし。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeTmp(prefix = 'psw-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 自分が mkdtemp で作った temp 内のフォルダだけ削除する
export function cleanup(dir) {
  const abs = path.resolve(dir);
  const tmpRoot = path.resolve(os.tmpdir());
  const rel = path.relative(tmpRoot, abs);
  const inTmp = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!inTmp || !path.basename(abs).startsWith('psw-')) {
    throw new Error(`cleanup を拒否: temp 内の psw-* ではない: ${abs}`);
  }
  try {
    fs.rmSync(abs, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function baseConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    name: 'TestApp',
    purpose: 'テスト用の目的',
    mvp: 'テスト用の MVP',
    audience: 'personal',
    outOfScope: ['共有機能'],
    phases: ['段階A', '段階B'],
    tech: '',
    verifyCommands: ['node --test'],
    mode: 'codex-led',
    handoff: 'manual',
    profile: 'minimal',
    // 別AIの起動は、既定 (主導担当が起動してよい) ではなく毎回承認を明示する。既定は launch-ui.test.mjs で確かめる
    launchPolicy: 'approval',
    layout: 'root',
    permissions: { allowedPaths: ['src/'], forbidden: ['外部送信'] },
    ...overrides,
  };
}

export function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  return file;
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8');
}
