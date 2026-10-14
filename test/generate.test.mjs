import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan } from '../src/plan.mjs';
import { generateToDir, regenerateToDir, diffAgainstExisting, GenerateError } from '../src/generate.mjs';
import { MANIFEST_FILE_NAME } from '../src/constants.mjs';
import { makeTmp, cleanup, baseConfig, readText } from './helpers.mjs';

const tmp = makeTmp();
after(() => cleanup(tmp));

function planFor(overrides) {
  return buildPlan(validateConfig(baseConfig(overrides)));
}

test('新規フォルダへ生成し、manifest のハッシュが実ファイルと一致', () => {
  const plan = planFor({});
  const out = path.join(tmp, 'gen1');
  const r = generateToDir({ plan, outDir: out, confirmDigest: plan.digest, now: '2026-10-11T00:00:00.000Z' });
  assert.equal(r.outDir, out);
  for (const f of plan.files) assert.equal(readText(path.join(out, f.path)), f.content);
  const manifest = JSON.parse(readText(path.join(out, MANIFEST_FILE_NAME)));
  assert.equal(manifest.planDigest, plan.digest);
  assert.equal(manifest.files.length, plan.files.length);
  // 一時フォルダが残っていない
  assert.ok(!fs.readdirSync(tmp).some((n) => n.startsWith('gen1.partial-')));
});

test('空でない出力先や既存ファイルがあれば停止し、上書きしない', () => {
  const plan = planFor({});
  const dir = path.join(tmp, 'exists-dir');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep', 'utf8');
  assert.throws(() => generateToDir({ plan, outDir: dir, confirmDigest: plan.digest }), /既に存在/);
  assert.equal(readText(path.join(dir, 'keep.txt')), 'keep');
  assert.ok(!fs.existsSync(path.join(dir, 'WORKFLOW.md')));
  const file = path.join(tmp, 'exists-file');
  fs.writeFileSync(file, 'x', 'utf8');
  assert.throws(() => generateToDir({ plan, outDir: file, confirmDigest: plan.digest }), /既に存在/);
  assert.equal(readText(file), 'x');
});

test('既存の空フォルダへ生成でき、隠し項目や空のサブフォルダがあれば拒否する', () => {
  const plan = planFor({});
  const out = path.join(tmp, 'empty-output');
  fs.mkdirSync(out);
  generateToDir({ plan, outDir: out, confirmDigest: plan.digest });
  for (const file of plan.files) assert.equal(readText(path.join(out, file.path)), file.content);
  assert.ok(fs.existsSync(path.join(out, MANIFEST_FILE_NAME)));
  for (const name of ['hidden-output', 'subdir-output']) {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    if (name === 'hidden-output') fs.writeFileSync(path.join(dir, '.keep'), 'keep');
    else fs.mkdirSync(path.join(dir, 'empty-subdir'));
    assert.throws(() => generateToDir({ plan, outDir: dir, confirmDigest: plan.digest }), /空の通常フォルダ/);
    assert.ok(!fs.existsSync(path.join(dir, MANIFEST_FILE_NAME)));
    assert.equal(fs.readdirSync(dir).length, 1);
  }
});

test('空フォルダへの生成が途中で失敗しても、元の空フォルダを残す', () => {
  const plan = planFor({});
  const out = path.join(tmp, 'empty-failed');
  fs.mkdirSync(out);
  const bad = { ...plan, files: [...plan.files, { path: '../escape.md', content: 'x' }] };
  assert.throws(() => generateToDir({ plan: bad, outDir: out, confirmDigest: plan.digest }), /不正な出力パス/);
  assert.deepEqual(fs.readdirSync(out), []);
  assert.ok(!fs.readdirSync(tmp).some(name => name.startsWith('empty-failed.partial-')));
});

test('生成中に空フォルダへ内容が追加されたら保護し、未作成の出力先が作られても拒否する', () => {
  const plan = planFor({});
  for (const existed of [true, false]) {
    const out = path.join(tmp, existed ? 'empty-concurrent' : 'new-concurrent');
    if (existed) fs.mkdirSync(out);
    const overrides = new Map();
    let changed = false;
    overrides.get = () => {
      if (!changed) {
        changed = true;
        if (existed) fs.writeFileSync(path.join(out, '.keep'), 'concurrent');
        else fs.mkdirSync(out);
      }
      return undefined;
    };
    assert.throws(() => generateToDir({ plan, outDir: out, confirmDigest: plan.digest, overrides }), /空の通常フォルダ|生成中に変わった/);
    assert.deepEqual(fs.readdirSync(out), existed ? ['.keep'] : []);
    if (existed) assert.equal(readText(path.join(out, '.keep')), 'concurrent');
    assert.ok(!fs.readdirSync(tmp).some(name => name.startsWith(path.basename(out) + '.partial-')));
  }
});

test('空フォルダの最終置換が失敗した場合も、元の空フォルダを復元する', () => {
  const plan = planFor({});
  const out = path.join(tmp, 'empty-rename-failed');
  fs.mkdirSync(out);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated rename failure'); };
  try {
    assert.throws(() => generateToDir({ plan, outDir: out, confirmDigest: plan.digest }), /simulated rename failure/);
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(fs.readdirSync(out), []);
  assert.ok(!fs.readdirSync(tmp).some(name => name.startsWith('empty-rename-failed.partial-')));
});

test('空フォルダを指すリンクには生成しない', t => {
  const plan = planFor({});
  const real = path.join(tmp, 'empty-link-real');
  const link = path.join(tmp, 'empty-link');
  fs.mkdirSync(real);
  try { fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('この環境ではリンクを作れない'); return; }
  assert.throws(() => generateToDir({ plan, outDir: link, confirmDigest: plan.digest }), /リンク/);
  assert.deepEqual(fs.readdirSync(real), []);
});

test('regenerate も空の別フォルダへ生成でき、比較元は変えない', () => {
  const plan = planFor({});
  const from = path.join(tmp, 'empty-regen-from');
  generateToDir({ plan, outDir: from, confirmDigest: plan.digest });
  const before = fs.readdirSync(from).map(name => [name, readText(path.join(from, name))]);
  const out = path.join(tmp, 'empty-regen-out');
  fs.mkdirSync(out);
  const report = diffAgainstExisting(plan, from);
  regenerateToDir({ plan, fromDir: from, outDir: out, confirmDigest: report.confirmDigest });
  assert.ok(fs.existsSync(path.join(out, MANIFEST_FILE_NAME)));
  assert.deepEqual(fs.readdirSync(from).map(name => [name, readText(path.join(from, name))]), before);
});

test('確認後に入力が変わると digest 不一致で拒否 (書き込みなし)', () => {
  const confirmed = planFor({}).digest;
  const changed = planFor({ mode: 'claude-led' });
  const out = path.join(tmp, 'gen-mismatch');
  assert.throws(() => generateToDir({ plan: changed, outDir: out, confirmDigest: confirmed }), /一致しません/);
  assert.ok(!fs.existsSync(out));
  assert.throws(() => generateToDir({ plan: changed, outDir: out, confirmDigest: '' }), GenerateError);
  assert.ok(!fs.existsSync(out));
});

test('必須未回答では生成しない', () => {
  const plan = planFor({ mvp: '' });
  const out = path.join(tmp, 'gen-required');
  assert.throws(() => generateToDir({ plan, outDir: out, confirmDigest: plan.digest }), /必須項目/);
  assert.ok(!fs.existsSync(out));
});

test('無人モードでは digest が合っていても生成しない', () => {
  const plan = planFor({});
  const out = path.join(tmp, 'gen-unattended');
  assert.throws(() => generateToDir({ plan, outDir: out, confirmDigest: plan.digest, unattended: true }), /無人モード/);
  assert.ok(!fs.existsSync(out));
});

test('途中失敗の保護: 親がない/不正パスでは出力も一時フォルダも残らない', () => {
  const plan = planFor({});
  const out = path.join(tmp, 'no-parent', 'gen');
  assert.throws(() => generateToDir({ plan, outDir: out, confirmDigest: plan.digest }), /親フォルダ/);
  assert.ok(!fs.existsSync(path.join(tmp, 'no-parent')));
  const bad = { ...plan, files: [...plan.files, { path: '../escape.md', content: 'x', sha256: '0', bytes: 1 }] };
  const out2 = path.join(tmp, 'gen-bad');
  assert.throws(() => generateToDir({ plan: bad, outDir: out2, confirmDigest: plan.digest }), /不正な出力パス/);
  assert.ok(!fs.existsSync(out2));
  assert.ok(!fs.existsSync(path.join(tmp, 'escape.md')));
  assert.ok(!fs.readdirSync(tmp).some((n) => n.startsWith('gen-bad.partial-')));
});

test('UNC パスは拒否', () => {
  const plan = planFor({});
  assert.throws(() => generateToDir({ plan, outDir: '\\\\server\\share\\out', confirmDigest: plan.digest }), /UNC/);
});

test('regenerate: 差分を提示し、別の新規フォルダへ生成、元は不変', () => {
  const plan1 = planFor({});
  const from = path.join(tmp, 'regen-from');
  generateToDir({ plan: plan1, outDir: from, confirmDigest: plan1.digest });
  const before = Object.fromEntries(fs.readdirSync(from).map((n) => [n, readText(path.join(from, n))]));

  const plan2 = planFor({ mode: 'claude-led' });
  const report = diffAgainstExisting(plan2, from);
  const wf = report.entries.find((e) => e.path === 'WORKFLOW.md');
  assert.equal(wf.status, 'changed');
  assert.ok(/^-- 主導: Codex/m.test(wf.diff));
  assert.ok(/^\+- 主導: Claude/m.test(wf.diff));
  assert.equal(report.entries.find((e) => e.path === 'VALIDATION.md').status, 'same');
  assert.equal(report.oldManifestDigest, plan1.digest);

  const out = path.join(tmp, 'regen-to');
  generateToDir({ plan: plan2, outDir: out, confirmDigest: plan2.digest });
  assert.ok(/- 主導: Claude/.test(readText(path.join(out, 'WORKFLOW.md'))));
  const after_ = Object.fromEntries(fs.readdirSync(from).map((n) => [n, readText(path.join(from, n))]));
  assert.deepEqual(after_, before, '比較元が変更された');
  // 元フォルダへの regenerate は既存のため拒否
  assert.throws(() => generateToDir({ plan: plan2, outDir: from, confirmDigest: plan2.digest }), /既に存在/);
});

test('regenerate: 単独化で不要になった入口は removed として報告', () => {
  const plan1 = planFor({});
  const from = path.join(tmp, 'regen-solo-from');
  generateToDir({ plan: plan1, outDir: from, confirmDigest: plan1.digest });
  const plan2 = planFor({ mode: 'claude-solo', handoff: undefined });
  const report = diffAgainstExisting(plan2, from);
  assert.equal(report.entries.find((e) => e.path === 'AGENTS.md').status, 'removed');
});
