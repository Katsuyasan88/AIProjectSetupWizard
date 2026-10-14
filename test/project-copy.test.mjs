import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planProjectCopy, copyProject, inventoryProject, formatProjectCopyReport } from '../src/project-copy.mjs';
import { planManagedEdits, applyManagedEdits } from '../src/managed-edit.mjs';
import { validateConfig } from '../src/config.mjs';
import { buildPlan } from '../src/plan.mjs';
import { generateToDir } from '../src/generate.mjs';
import { makeTmp, cleanup, baseConfig } from './helpers.mjs';

const tmp = makeTmp('psw-copy-');
after(() => cleanup(tmp));
function seed(name) {
  const source = path.join(tmp, name);
  for (const directory of ['src', 'docs', 'images', '.git', 'node_modules/package', 'empty']) fs.mkdirSync(path.join(source, directory), { recursive: true });
  for (const [filename, content] of Object.entries({ 'AGENTS.md': '# Codex\n独自ルール\n', 'src/main.js': 'export const main = 1;\n', 'docs/design.md': '# 設計\n', '.env': 'PRIVATE=fake-private-value\n', 'local.key': 'fake-private-key\n', '.git/config': 'fake-git-config\n', 'node_modules/package/index.js': 'dependency', 'images/test.bin': Buffer.from([0, 255, 17]) })) fs.writeFileSync(path.join(source, filename), content);
  return source;
}
function changes(content = '# Claude\n独自ルール\n') { return { mode: 'claude-solo', files: [{ path: 'AGENTS.md', content }] }; }
function snapshot(directory) {
  const result = inventoryProject(directory, 'all');
  return result.entries.filter(entry => !entry.path.startsWith('.psw-backup')).map(entry => ({ ...entry }));
}

test('全体コピーは秘密・Git・依存・バイナリ・空ディレクトリを保持し、直接更新と同じ結果になる', () => {
  const source = seed('source-all');
  const before = snapshot(source);
  const direct = seed('direct-all');
  const edit = planManagedEdits(changes(), direct);
  applyManagedEdits({ changes: changes(), targetDir: direct, confirmDigest: edit.confirmDigest });
  const out = path.join(tmp, 'copy-all');
  const report = planProjectCopy({ targetDir: source, outDir: out, scope: 'all', changes: changes() });
  assert.ok(!fs.existsSync(out), '計画だけでは出力しない');
  assert.ok(!formatProjectCopyReport(report).includes('fake-private-value'));
  const result = copyProject({ targetDir: source, outDir: out, scope: 'all', changes: changes(), confirmDigest: report.confirmDigest });
  assert.deepEqual(snapshot(out), snapshot(direct));
  assert.deepEqual(snapshot(source), before, 'コピー元を変えない');
  assert.equal(fs.readFileSync(path.join(out, '.env'), 'utf8'), 'PRIVATE=fake-private-value\n');
  assert.ok(fs.existsSync(path.join(result.backupDir, 'AGENTS.md')));
  assert.deepEqual(fs.readdirSync(path.join(out, 'empty')), []);
});

test('コピー範囲・文書変更・元コード・出力先はすべて承認digestに含まれる', () => {
  const source = seed('source-confirm');
  const out = path.join(tmp, 'copy-confirm');
  const options = { targetDir: source, outDir: out, scope: 'all', changes: changes() };
  const report = planProjectCopy(options);
  for (const changed of [{ ...options, scope: 'safe' }, { ...options, changes: changes('別の文書\n') }, { ...options, outDir: path.join(tmp, 'other-confirm') }]) {
    assert.throws(() => copyProject({ ...changed, confirmDigest: report.confirmDigest }), /一致しません/);
  }
  fs.appendFileSync(path.join(source, 'src/main.js'), '// user edit\n');
  assert.throws(() => copyProject({ ...options, confirmDigest: report.confirmDigest }), /一致しません/);
  assert.ok(!fs.existsSync(out));
});

test('safe は秘密・Git・依存を除外し、全体コピーにも範囲の明示と有人承認が必要', () => {
  const source = seed('source-safe');
  const out = path.join(tmp, 'copy-safe');
  assert.throws(() => planProjectCopy({ targetDir: source, outDir: out }), /明示/);
  const options = { targetDir: source, outDir: out, scope: 'safe' };
  const report = planProjectCopy(options);
  assert.ok(report.inventory.skipped.some(entry => entry.path === '.env'));
  assert.throws(() => copyProject({ ...options, confirmDigest: report.confirmDigest, unattended: true }), /無人/);
  copyProject({ ...options, confirmDigest: report.confirmDigest });
  for (const filename of ['.env', 'local.key', '.git', 'node_modules']) assert.ok(!fs.existsSync(path.join(out, filename)));
  assert.ok(fs.existsSync(path.join(out, 'src/main.js')));
});

test('空のコピー先は使えるが、非空・比較元配下・通常ファイルは拒否する', () => {
  const source = seed('source-output');
  const out = path.join(tmp, 'empty-copy');
  fs.mkdirSync(out);
  const options = { targetDir: source, outDir: out, scope: 'all' };
  const report = planProjectCopy(options);
  copyProject({ ...options, confirmDigest: report.confirmDigest });
  assert.ok(fs.existsSync(path.join(out, 'src/main.js')));
  assert.throws(() => planProjectCopy(options), /空の通常フォルダ/);
  assert.throws(() => planProjectCopy({ ...options, outDir: path.join(source, 'empty') }), /別のフォルダ/);
});

test('コピー中の元案件・出力先の変化を検出し、途中出力を残さない', () => {
  const source = seed('source-race');
  const out = path.join(tmp, 'race-copy');
  fs.mkdirSync(out);
  const options = { targetDir: source, outDir: out, scope: 'all' };
  const report = planProjectCopy(options);
  let touched = false;
  assert.throws(() => copyProject({ ...options, confirmDigest: report.confirmDigest, onCopy() {
    if (!touched) { touched = true; fs.writeFileSync(path.join(source, 'new-user-file'), 'user'); }
  } }), /元の案件が変わった/);
  assert.deepEqual(fs.readdirSync(out), []);
  assert.ok(!fs.readdirSync(tmp).some(name => name.startsWith('race-copy.partial-')));
  const fresh = planProjectCopy(options);
  assert.throws(() => copyProject({ ...options, confirmDigest: fresh.confirmDigest, onCopy() { fs.writeFileSync(path.join(out, 'user.txt'), 'user'); } }), /空の通常フォルダ/);
  assert.equal(fs.readFileSync(path.join(out, 'user.txt'), 'utf8'), 'user');
});

test('リンクは辿らず、案件外を読まない・コピーしない', t => {
  const source = seed('source-link');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'private.txt'), 'must-not-copy');
  try { fs.symlinkSync(outside, path.join(source, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('リンクを作れない環境'); return; }
  const out = path.join(tmp, 'copy-link');
  const options = { targetDir: source, outDir: out, scope: 'all' };
  const report = planProjectCopy(options);
  assert.ok(report.inventory.skipped.some(entry => entry.path === 'outside-link'));
  copyProject({ ...options, confirmDigest: report.confirmDigest });
  assert.ok(!fs.existsSync(path.join(out, 'outside-link')));
});

test('ウィザード標準も案件全体を保ちながら、直接applyと同じ文書をコピー先に作る', () => {
  const plan = buildPlan(validateConfig(baseConfig()));
  const source = path.join(tmp, 'standard-source');
  generateToDir({ plan, outDir: source, confirmDigest: plan.digest });
  fs.mkdirSync(path.join(source, 'src'));
  fs.writeFileSync(path.join(source, 'src/main.js'), 'implementation');
  const next = buildPlan(validateConfig(baseConfig({ mode: 'claude-solo', ai: { claude: { model: 'opus', effort: 'high' } } })));
  const out = path.join(tmp, 'standard-copy');
  const options = { targetDir: source, outDir: out, scope: 'all', plan: next };
  const report = planProjectCopy(options);
  copyProject({ ...options, confirmDigest: report.confirmDigest });
  assert.equal(fs.readFileSync(path.join(out, 'src/main.js'), 'utf8'), 'implementation');
  assert.equal(fs.readFileSync(path.join(out, 'WORKFLOW.md'), 'utf8'), next.files.find(file => file.path === 'WORKFLOW.md').content);
  assert.ok(!fs.existsSync(path.join(out, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(source, 'AGENTS.md')));
});

test('既存ルール優先の変更はコードを触れず、失敗時に文書を復元する', () => {
  const source = seed('source-edit-failed');
  const original = snapshot(source);
  const edits = { files: [{ path: 'AGENTS.md', content: '変更\n' }, { path: 'START.md', content: '開始\n' }] };
  const report = planManagedEdits(edits, source);
  assert.throws(() => applyManagedEdits({ changes: edits, targetDir: source, confirmDigest: report.confirmDigest, onWrite() { throw new Error('simulated failure'); } }), /変更を戻しました/);
  assert.deepEqual(snapshot(source), original);
  assert.throws(() => planManagedEdits({ files: [{ path: 'src/main.js', content: 'bad' }] }, source), /管理文書以外/);
  for (const filename of ['AGENTS.md:note.md', 'CON.md', '../escape.md']) {
    assert.throws(() => planManagedEdits({ documents: [filename], files: [{ path: filename, content: 'bad' }] }, source), /通常の md 名/);
  }
});

test('明示した非空コピー先の置換は、旧フォルダを丸ごと退避し、変更後の承認を流用しない', () => {
  const source = seed('source-replacement');
  const out = path.join(tmp, 'replacement');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'user.txt'), 'old output');
  const options = { targetDir: source, outDir: out, scope: 'all', replaceOutput: true, changes: changes() };
  const report = planProjectCopy(options);
  assert.match(formatProjectCopyReport(report), /削除せず/);
  assert.throws(() => planProjectCopy({ ...options, targetDir: out + '.psw-backup' }), /退避先が元の案件/);
  fs.appendFileSync(path.join(out, 'user.txt'), '!');
  assert.throws(() => copyProject({ ...options, confirmDigest: report.confirmDigest }), /一致しません/);
  const current = planProjectCopy(options);
  const result = copyProject({ ...options, confirmDigest: current.confirmDigest });
  assert.equal(fs.readFileSync(path.join(result.outputBackupDir, 'user.txt'), 'utf8'), 'old output!');
  assert.ok(fs.existsSync(path.join(out, 'src/main.js')));
  assert.ok(!fs.existsSync(path.join(out, 'user.txt')));
});

test('既存コピー先の置換中の編集と最終rename失敗では旧コピー先を保持する', () => {
  const source = seed('source-replacement-race');
  const out = path.join(tmp, 'replacement-race');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'old.txt'), 'old');
  const options = { targetDir: source, outDir: out, scope: 'all', replaceOutput: true };
  let touched = false;
  const report = planProjectCopy(options);
  assert.throws(() => copyProject({ ...options, confirmDigest: report.confirmDigest, onCopy() {
    if (!touched) { touched = true; fs.appendFileSync(path.join(out, 'old.txt'), '!'); }
  } }), /出力先が変わった/);
  const rename = fs.renameSync;
  const mocked = mock.method(fs, 'renameSync', (from, to) => {
    if (from.startsWith(out + '.partial-') && to === out) throw new Error('simulated rename failure');
    return rename(from, to);
  });
  try {
    const next = planProjectCopy(options);
    assert.throws(() => copyProject({ ...options, confirmDigest: next.confirmDigest }), /simulated rename failure/);
    assert.equal(fs.readFileSync(path.join(out, 'old.txt'), 'utf8'), 'old!');
  } finally { mocked.mock.restore(); }
});
