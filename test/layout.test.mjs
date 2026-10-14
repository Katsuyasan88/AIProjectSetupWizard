// 文書の配置 (layout)。既定の folders: 入口だけルート、ほかの文書は docs/、設定と記録は initial-settings/。
// ほかのテストは以前の配置 (root) で動かしている (test/helpers.mjs の baseConfig)。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan } from '../src/plan.mjs';
import { generateToDir, regenerateToDir, diffAgainstExisting } from '../src/generate.mjs';
import { planApply, applyToDir } from '../src/apply.mjs';
import { auditTarget } from '../src/audit.mjs';
import { findExisting } from '../src/layout.mjs';
import { MODES, MODE_NAMES, ENTRY_FILE, CONFIG_FILE_NAME, MANIFEST_FILE_NAME } from '../src/constants.mjs';
import { PROFILES } from '../src/render-profile.mjs';
import { makeTmp, cleanup, baseConfig, readText } from './helpers.mjs';

const tmp = makeTmp();
after(() => cleanup(tmp));

const planFor = (mode, ov = {}) => buildPlan(validateConfig(baseConfig({ mode, handoff: MODES[mode].solo ? undefined : 'manual', layout: 'folders', ...ov })));
const fileOf = (plan, rel) => plan.files.find((f) => f.path === rel)?.content ?? null;
let seq = 0;
function gen(plan) {
  const dir = path.join(tmp, `l${++seq}`);
  generateToDir({ plan, outDir: dir, confirmDigest: plan.digest });
  return dir;
}
// フォルダの中の全ファイル ('/' 区切りの相対パス、並び替え済み)
function tree(dir, prefix = '') {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? tree(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}
const rootFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
const manifestOf = (dir) => JSON.parse(readText(path.join(dir, 'initial-settings', MANIFEST_FILE_NAME)));
const nonInfo = (dir) => auditTarget(dir).findings.filter((f) => f.severity !== 'info');

test('既定は folders。知らない配置は拒否する', () => {
  const { layout, ...rest } = baseConfig();
  assert.equal(validateConfig(rest).config.layout, 'folders');
  assert.throws(() => validateConfig(baseConfig({ layout: 'flat' })), /layout/);
});

test('4 モード × 3 段階: ルートは入口と .gitignore だけ。文書は docs/、設定と記録は initial-settings/。生成直後の監査は検出 0', () => {
  for (const mode of MODE_NAMES) {
    for (const profile of PROFILES) {
      const plan = planFor(mode, { profile, projectRules: ['例のルール'], handover: ['例の引継ぎ'] });
      const dir = gen(plan);
      const entries = MODES[mode].agents.map((a) => ENTRY_FILE[a]).sort();
      assert.deepEqual(rootFiles(dir), ['.gitignore', ...entries].sort(), `${mode}/${profile}: ルート`);
      assert.deepEqual(fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(), ['docs', 'initial-settings'], `${mode}/${profile}`);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'initial-settings')).sort(), [MANIFEST_FILE_NAME, CONFIG_FILE_NAME].sort(), `${mode}/${profile}`);
      for (const name of ['WORKFLOW.md', 'PROJECT.md', 'TASKS.md', 'VALIDATION.md', 'START.md', 'RULES.md']) assert.ok(fs.existsSync(path.join(dir, 'docs', name)), `${mode}/${profile}: docs/${name}`);
      assert.deepEqual(auditTarget(dir).findings, [], `${mode}/${profile}: 監査`);
      // 記録のパスも新しい配置
      assert.ok(manifestOf(dir).files.every((f) => f.path.includes('/') || entries.includes(f.path)), `${mode}/${profile}`);
    }
  }
});

test('リンクと文中のパス: 入口は docs/ を指し、docs/ の文書は入口を 1 つ上で指す。開始文はルートからのパスで書く', () => {
  for (const mode of MODE_NAMES) {
    const plan = planFor(mode, { profile: 'standard' });
    for (const a of MODES[mode].agents) {
      const e = fileOf(plan, ENTRY_FILE[a]);
      assert.ok(e.includes('[docs/WORKFLOW.md](docs/WORKFLOW.md)') && e.includes('(docs/TASKS.md)') && e.includes('(docs/CONTEXT.md)'), `${mode}/${a}`);
      assert.ok(!/\]\((?!docs\/|https?:)[A-Z_]+\.md\)/.test(e), `${mode}/${a}: ルート前提のリンクが残っている`);
      assert.ok(!/(?<![\w/.-])(WORKFLOW|TASKS|VALIDATION|PROJECT|START|CONTEXT)\.md/.test(e), `${mode}/${a}: docs/ の付かない文書名が残っている`);
    }
    const wf = fileOf(plan, 'docs/WORKFLOW.md');
    for (const a of MODES[mode].agents) assert.ok(wf.includes(`](../${ENTRY_FILE[a]})`), `${mode}: 正本から入口へのリンク`);
    assert.ok(wf.includes('[TASKS.md](TASKS.md)'), `${mode}: 同じフォルダの文書へのリンクはそのまま`);
    const start = fileOf(plan, 'docs/START.md');
    const prompts = start.split('```').filter((_, i) => i % 2 === 1).join('\n');
    assert.ok(/docs\/WORKFLOW\.md を読み/.test(prompts) && /docs\/TASKS\.md/.test(prompts), `${mode}: 開始文`);
    assert.ok(!/(?<![\w/.-])(WORKFLOW|TASKS|PROJECT)\.md/.test(prompts), `${mode}: 開始文に docs/ の付かない文書名`);
  }
});

test('監査: docs/ の課題表と結果記録を読み、OK 以外の結果のまま完了にすると検出する。欠落はリンク切れとして出る', () => {
  const dir = gen(planFor('claude-solo', { profile: 'standard' }));
  const tasks = path.join(dir, 'docs', 'TASKS.md');
  fs.appendFileSync(path.join(dir, 'docs', 'VALIDATION.md'), '| 2026-10-12 | T-001 | NG | logs/t1.txt | 自己確認 | a1b2c3 | 失敗 |\n');
  fs.writeFileSync(tasks, readText(tasks).replace(/^- \[ \] T-001 (.*)$/m, '- [x] T-001 $1 証跡: logs/t1.txt'));
  const f = nonInfo(dir).find((x) => x.category === 'done-but-validation-failed');
  assert.ok(f && f.file === 'docs/TASKS.md', '検出の場所は実際のパス');

  const broken = gen(planFor('claude-solo', { profile: 'standard' }));
  fs.rmSync(path.join(broken, 'docs', 'VALIDATION.md'));
  const cats = nonInfo(broken).map((x) => x.category);
  assert.ok(cats.includes('missing-file') && cats.includes('broken-link'));
});

test('更新: docs/ の文書を書き換え、変更前を initial-settings/backup/ に残す。書き足した課題表は残る。履歴が積まれる', () => {
  const dir = gen(planFor('codex-led'));
  fs.appendFileSync(path.join(dir, 'docs', 'TASKS.md'), '\n- [ ] T-009 自分で足した課題\n');
  const old = readText(path.join(dir, 'docs', 'WORKFLOW.md'));
  const p2 = planFor('claude-led');
  const r = planApply(p2, dir);
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.relocations, []);
  const done = applyToDir({ plan: p2, targetDir: dir, confirmDigest: r.confirmDigest });
  assert.ok(/- 主導: Claude/.test(readText(path.join(dir, 'docs', 'WORKFLOW.md'))));
  assert.ok(/T-009 自分で足した課題/.test(readText(path.join(dir, 'docs', 'TASKS.md'))));
  assert.ok(done.backupDir.startsWith(path.join(dir, 'initial-settings', 'backup')));
  assert.equal(readText(path.join(done.backupDir, 'docs', 'WORKFLOW.md')), old);
  assert.equal(readText(path.join(dir, 'initial-settings', 'backup', '.gitignore')).trim(), '*');
  assert.ok(!fs.existsSync(path.join(dir, '.psw-backup')), 'ルートにバックアップ用のフォルダを作らない');
  assert.equal(manifestOf(dir).history.length, 2);
  assert.deepEqual(nonInfo(dir), []);
  assert.ok(!tree(dir).some((p) => p.includes('.psw-tmp-')));
});

test('以前の配置 (ルート) の案件を新しい配置へ移す: 文書は docs/ へ、設定と記録は initial-settings/ へ。書き足しは中身を変えずに移す', () => {
  const legacy = buildPlan(validateConfig(baseConfig({ mode: 'codex-led', layout: 'root' })));
  const dir = gen(legacy);
  fs.appendFileSync(path.join(dir, 'TASKS.md'), '\n- [ ] T-009 自分で足した課題\n');
  const editedTasks = readText(path.join(dir, 'TASKS.md'));
  const oldWorkflow = readText(path.join(dir, 'WORKFLOW.md'));
  const p2 = planFor('codex-led');
  const r = planApply(p2, dir);
  assert.deepEqual(r.blockers, []);
  assert.ok(r.relocations.some((x) => x.from === 'TASKS.md' && x.to === 'docs/TASKS.md'));
  assert.equal(r.legacyManifestRel, MANIFEST_FILE_NAME);
  assert.equal(r.entries.find((e) => e.path === 'docs/TASKS.md').status, 'moved');

  // 途中で失敗したら、ルートの配置のまま元へ戻る
  const before = tree(dir).filter((p) => !p.startsWith('initial-settings/backup/'));
  let n = 0;
  assert.throws(() => applyToDir({ plan: p2, targetDir: dir, confirmDigest: r.confirmDigest, onWrite: () => { if (++n === 4) throw new Error('試験用の失敗'); } }), /元へ戻しました/);
  assert.deepEqual(tree(dir).filter((p) => !p.startsWith('initial-settings/backup/')), before);
  assert.equal(readText(path.join(dir, 'TASKS.md')), editedTasks);

  const r2 = planApply(p2, dir);
  const done = applyToDir({ plan: p2, targetDir: dir, confirmDigest: r2.confirmDigest });
  assert.deepEqual(rootFiles(dir), ['.gitignore', 'AGENTS.md', 'CLAUDE.md']);
  assert.equal(readText(path.join(dir, 'docs', 'TASKS.md')), editedTasks, '書き足した課題表は中身を変えずに移る');
  assert.ok(readText(path.join(dir, 'docs', 'WORKFLOW.md')).includes('](../CLAUDE.md)'));
  assert.equal(readText(path.join(done.backupDir, 'WORKFLOW.md')), oldWorkflow, '元のファイルはバックアップにある');
  assert.ok(fs.existsSync(path.join(done.backupDir, MANIFEST_FILE_NAME)) && fs.existsSync(path.join(done.backupDir, 'TASKS.md')));
  const m = manifestOf(dir);
  assert.equal(m.history.length, 2, '以前の記録の履歴を引き継ぐ');
  assert.ok(m.history[1].moved.includes('TASKS.md') && m.history[1].changed.includes('docs/TASKS.md'));
  assert.deepEqual(nonInfo(dir), []);
  assert.equal(planApply(p2, dir).nothingToDo, true, '移し終えたら差分なし');
});

test('導入: ウィザードなしの案件のルートにある同名の文書は、移さず・変えずに残す (新しい文書は docs/ に作る)', () => {
  const dir = path.join(tmp, 'foreign');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# 自作の入口\n');
  fs.writeFileSync(path.join(dir, 'TASKS.md'), '- [ ] 自作の課題\n');
  const plan = planFor('claude-solo');
  const r = planApply(plan, dir, { adopt: true });
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.relocations, []);
  assert.deepEqual(r.kept.map((k) => k.path), ['CLAUDE.md']);
  applyToDir({ plan, targetDir: dir, confirmDigest: r.confirmDigest, adopt: true });
  assert.equal(readText(path.join(dir, 'TASKS.md')), '- [ ] 自作の課題\n');
  assert.equal(readText(path.join(dir, 'CLAUDE.md')), '# 自作の入口\n');
  assert.ok(fs.existsSync(path.join(dir, 'docs', 'TASKS.md')) && fs.existsSync(path.join(dir, 'initial-settings', MANIFEST_FILE_NAME)));
  // 入口の置き換えは、名前でもパスでも指定できる
  const dir2 = path.join(tmp, 'foreign2');
  fs.mkdirSync(dir2);
  fs.writeFileSync(path.join(dir2, 'CLAUDE.md'), '# 自作の入口\n');
  const r2 = planApply(plan, dir2, { adopt: true, replace: ['CLAUDE.md'] });
  const done = applyToDir({ plan, targetDir: dir2, confirmDigest: r2.confirmDigest, adopt: true, replace: ['CLAUDE.md'] });
  assert.ok(readText(path.join(dir2, 'CLAUDE.md')).includes('docs/WORKFLOW.md'));
  assert.ok(/自作の入口/.test(readText(path.join(done.backupDir, 'CLAUDE.md'))));
});

test('別フォルダへの生成: 以前の配置の案件から、新しい配置の一式を作る。書き足した課題表は docs/ へ引き継ぎ、元は変えない', () => {
  const src = gen(buildPlan(validateConfig(baseConfig({ mode: 'codex-led', layout: 'root' }))));
  fs.appendFileSync(path.join(src, 'TASKS.md'), '\n- [ ] T-009 自分で足した課題\n');
  const edited = readText(path.join(src, 'TASKS.md'));
  const before = tree(src);
  const plan = planFor('claude-led');
  const d = diffAgainstExisting(plan, src);
  assert.equal(d.entries.find((e) => e.path === 'docs/TASKS.md').status, 'carried');
  const out = path.join(tmp, 'regen-out');
  regenerateToDir({ plan, fromDir: src, outDir: out, confirmDigest: d.confirmDigest });
  assert.equal(readText(path.join(out, 'docs', 'TASKS.md')), edited);
  assert.deepEqual(rootFiles(out), ['.gitignore', 'AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(tree(src), before, '元は変えない');
});

test('設定と記録の場所: 新しい配置を先に探し、なければルートを見る。おすすめの .gitignore はバックアップの場所を無視する', () => {
  const folders = gen(planFor('claude-solo'));
  assert.equal(findExisting(folders, CONFIG_FILE_NAME), `initial-settings/${CONFIG_FILE_NAME}`);
  assert.equal(findExisting(folders, MANIFEST_FILE_NAME), `initial-settings/${MANIFEST_FILE_NAME}`);
  const root = gen(buildPlan(validateConfig(baseConfig({ mode: 'claude-solo', layout: 'root' }))));
  assert.equal(findExisting(root, CONFIG_FILE_NAME), CONFIG_FILE_NAME);
  assert.equal(findExisting(path.join(tmp, 'nowhere'), CONFIG_FILE_NAME), null);
  const gi = readText(path.join(folders, '.gitignore')).split('\n');
  assert.ok(gi.includes('initial-settings/backup/') && gi.includes('.psw-backup/'));
});
