// おすすめの .gitignore (ないときだけ作る) と、git 開始の初期タスク。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan } from '../src/plan.mjs';
import { generateToDir } from '../src/generate.mjs';
import { planApply, applyToDir } from '../src/apply.mjs';
import { planGitignore, writeGitignore } from '../src/seed.mjs';
import { auditTarget } from '../src/audit.mjs';
import { MODES, MODE_NAMES, MANIFEST_FILE_NAME } from '../src/constants.mjs';
import { makeTmp, cleanup, baseConfig, readText } from './helpers.mjs';

const tmp = makeTmp();
after(() => cleanup(tmp));

const planFor = (mode, ov = {}) => buildPlan(validateConfig(baseConfig({ mode, handoff: MODES[mode].solo ? undefined : 'manual', ...ov })));
const fileOf = (plan, name) => plan.files.find((f) => f.path === name)?.content ?? null;
const GI = '.gitignore';

test('新規生成: おすすめの .gitignore が入る。設定で作らない指定もできる。manifest の files には入れない', () => {
  const plan = planFor('claude-solo');
  const dir = path.join(tmp, 'new');
  generateToDir({ plan, outDir: dir, confirmDigest: plan.digest });
  const gi = readText(path.join(dir, GI));
  for (const line of ['.env', '*.pem', 'node_modules/', '.psw-backup/']) assert.ok(gi.split('\n').includes(line), line);
  const manifest = JSON.parse(readText(path.join(dir, MANIFEST_FILE_NAME)));
  assert.ok(!manifest.files.some((f) => f.path === GI));
  assert.ok(manifest.history[0].changed.includes(GI));
  assert.deepEqual(auditTarget(dir).findings, []);

  const off = planFor('claude-solo', { gitignore: false });
  assert.deepEqual(off.seeds, []);
  assert.notEqual(off.digest, plan.digest, '作る/作らないで digest が変わる');
  const dir2 = path.join(tmp, 'new-off');
  generateToDir({ plan: off, outDir: dir2, confirmDigest: off.digest });
  assert.ok(!fs.existsSync(path.join(dir2, GI)));
  assert.throws(() => validateConfig(baseConfig({ gitignore: 'yes' })), /gitignore/);
});

test('更新: 既にある .gitignore は内容が違っても触らない。消されていたら、承認のうえで作り直す', () => {
  const plan = planFor('codex-led');
  const dir = path.join(tmp, 'apply');
  generateToDir({ plan, outDir: dir, confirmDigest: plan.digest });
  fs.writeFileSync(path.join(dir, GI), '# 自分の設定\nsecret-folder/\n');
  const r1 = planApply(planFor('claude-led'), dir);
  assert.deepEqual(r1.seeds, []);
  assert.deepEqual(r1.seedsExisting, [GI]);
  applyToDir({ plan: planFor('claude-led'), targetDir: dir, confirmDigest: r1.confirmDigest });
  assert.equal(readText(path.join(dir, GI)), '# 自分の設定\nsecret-folder/\n');

  fs.rmSync(path.join(dir, GI));
  const p = planFor('claude-led');
  const r2 = planApply(p, dir);
  assert.equal(r2.nothingToDo, false);
  assert.deepEqual(r2.seeds.map((s) => s.path), [GI]);
  assert.notEqual(r2.confirmDigest, r1.confirmDigest);
  const done = applyToDir({ plan: p, targetDir: dir, confirmDigest: r2.confirmDigest });
  assert.ok(done.written.includes(GI) && fs.existsSync(path.join(dir, GI)));
  assert.equal(planApply(p, dir).nothingToDo, true);
});

test('導入: ウィザードなしの案件でも、ないときだけ .gitignore を足す。git の有無は存在だけを見て報告する', () => {
  const a = path.join(tmp, 'adopt-none');
  fs.mkdirSync(a);
  fs.writeFileSync(path.join(a, 'CLAUDE.md'), '# 自作の入口\n');
  const plan = planFor('claude-solo');
  const r = planApply(plan, a, { adopt: true });
  assert.deepEqual(r.seeds.map((s) => s.path), [GI]);
  assert.equal(r.gitPresent, false);
  applyToDir({ plan, targetDir: a, confirmDigest: r.confirmDigest, adopt: true });
  assert.ok(fs.existsSync(path.join(a, GI)));

  const b = path.join(tmp, 'adopt-has');
  fs.mkdirSync(path.join(b, '.git'), { recursive: true });
  fs.writeFileSync(path.join(b, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(b, GI), 'mine\n');
  const rb = planApply(plan, b, { adopt: true });
  assert.equal(rb.gitPresent, true);
  assert.deepEqual(rb.seeds, []);
  applyToDir({ plan, targetDir: b, confirmDigest: rb.confirmDigest, adopt: true });
  assert.equal(readText(path.join(b, GI)), 'mine\n');
  assert.deepEqual(fs.readdirSync(path.join(b, '.git')), ['HEAD'], '.git の中には触らない');
});

test('単独の gitignore 操作: ないときだけ、digest の承認後に作る。既にあれば何もしない', () => {
  const dir = path.join(tmp, 'solo');
  fs.mkdirSync(dir);
  const r = planGitignore(dir);
  assert.equal(r.exists, false);
  assert.throws(() => writeGitignore({ targetDir: dir, confirmDigest: '0'.repeat(64) }), /一致しません/);
  assert.throws(() => writeGitignore({ targetDir: dir, confirmDigest: r.confirmDigest, unattended: true }), /無人/);
  assert.ok(!fs.existsSync(path.join(dir, GI)));
  writeGitignore({ targetDir: dir, confirmDigest: r.confirmDigest });
  assert.equal(readText(path.join(dir, GI)), r.content);
  fs.writeFileSync(path.join(dir, GI), 'changed by user\n');
  assert.equal(planGitignore(dir).exists, true);
  assert.throws(() => writeGitignore({ targetDir: dir, confirmDigest: r.confirmDigest }), /既にある/);
  assert.equal(readText(path.join(dir, GI)), 'changed by user\n');
  // 別のフォルダ向けの承認は使えない
  const other = path.join(tmp, 'solo-other');
  fs.mkdirSync(other);
  assert.throws(() => writeGitignore({ targetDir: other, confirmDigest: r.confirmDigest }), /一致しません/);
});

test('4 モード: 初期確認 (T-000) に git 開始の項目があり、承認後・push なしと明記。作業文書に担当名は入らない', () => {
  for (const mode of MODE_NAMES) {
    const t = fileOf(planFor(mode), 'TASKS.md');
    const init = t.slice(t.indexOf('## 初期確認'), t.indexOf('## 課題'));
    assert.ok(/^ {2}- バージョン管理: このフォルダが git 管理でなければ/m.test(init), mode);
    assert.ok(/ユーザーの承認後/.test(init) && /push はしない/.test(init), mode);
    assert.ok(!/Codex|Claude/.test(t), mode);
  }
});
