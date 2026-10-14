// 実行履歴: どの版のツールとテンプレートで、何をしたかを manifest に積む。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan } from '../src/plan.mjs';
import { generateToDir, regenerateToDir, diffAgainstExisting, readHistory } from '../src/generate.mjs';
import { planApply, applyToDir } from '../src/apply.mjs';
import { MODES, MANIFEST_FILE_NAME, TOOL_VERSION, TEMPLATE_VERSION } from '../src/constants.mjs';
import { makeTmp, cleanup, baseConfig, readText } from './helpers.mjs';

const tmp = makeTmp();
after(() => cleanup(tmp));

const planFor = (mode, ov = {}) => buildPlan(validateConfig(baseConfig({ mode, handoff: MODES[mode].solo ? undefined : 'manual', ...ov })));
const manifestOf = (dir) => JSON.parse(readText(path.join(dir, MANIFEST_FILE_NAME)));

test('履歴: 新規生成で 1 件、更新のたびに 1 件ずつ増え、版・操作・書いたファイルを記録する', () => {
  const dir = path.join(tmp, 'hist');
  const p1 = planFor('codex-led');
  generateToDir({ plan: p1, outDir: dir, confirmDigest: p1.digest, now: '2026-10-12T01:00:00.000Z' });
  let h = manifestOf(dir).history;
  assert.equal(h.length, 1);
  assert.deepEqual(
    { action: h[0].action, toolVersion: h[0].toolVersion, templateVersion: h[0].templateVersion, mode: h[0].mode, at: h[0].at },
    { action: 'generate', toolVersion: TOOL_VERSION, templateVersion: TEMPLATE_VERSION, mode: 'codex-led', at: '2026-10-12T01:00:00.000Z' },
  );
  assert.ok(h[0].changed.includes('WORKFLOW.md'));

  // 単独化: 入口を 1 つ退避し、書き足した課題表は残す
  fs.appendFileSync(path.join(dir, 'TASKS.md'), '\n- [ ] #t9 足した課題\n');
  const p2 = planFor('claude-solo');
  const r = planApply(p2, dir);
  applyToDir({ plan: p2, targetDir: dir, confirmDigest: r.confirmDigest, now: '2026-10-12T02:00:00.000Z' });
  h = manifestOf(dir).history;
  assert.equal(h.length, 2);
  assert.equal(h[1].action, 'apply');
  assert.equal(h[1].mode, 'claude-solo');
  // 課題表は残すが、役割の変更にともなう対応を末尾へ追記したので「書いた」にも入る
  assert.ok(h[1].changed.includes('WORKFLOW.md') && h[1].changed.includes('TASKS.md'));
  assert.deepEqual(h[1].moved, ['AGENTS.md']);
  assert.ok(h[1].kept.includes('TASKS.md'));
  assert.equal(h[0].at, '2026-10-12T01:00:00.000Z', '前の記録が残る');
  assert.ok(!JSON.stringify(h).includes(tmp), '絶対パスを記録しない');
});

test('履歴: 導入は adopt、別フォルダへの生成は regenerate として記録し、比較元のパスは残さない', () => {
  const src = path.join(tmp, 'foreign');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'CLAUDE.md'), '# 自作の入口\n');
  const plan = planFor('claude-solo');
  const d = diffAgainstExisting(plan, src);
  const out = path.join(tmp, 'foreign-out');
  regenerateToDir({ plan, fromDir: src, outDir: out, confirmDigest: d.confirmDigest });
  const hr = manifestOf(out).history;
  assert.equal(hr.length, 1);
  assert.equal(hr[0].action, 'regenerate');
  assert.ok(!JSON.stringify(manifestOf(out)).includes('foreign'), '比較元の名前を記録しない');

  const r = planApply(plan, src, { adopt: true });
  applyToDir({ plan, targetDir: src, confirmDigest: r.confirmDigest, adopt: true });
  const ha = manifestOf(src).history;
  assert.equal(ha.length, 1);
  assert.equal(ha[0].action, 'adopt');
  assert.deepEqual(ha[0].kept, ['CLAUDE.md']);
});

test('履歴: 履歴のない古い manifest は最初の 1 件として引き継ぎ、壊れた項目や秘密らしい値は持ち越さない', () => {
  const old = { tool: 'ProjectSetupWizard', version: '0.0.9', templateVersion: '1', generatedAt: '2026-01-01T00:00:00.000Z', mode: 'claude-solo', planDigest: 'abc', files: [{ path: 'WORKFLOW.md' }] };
  const h = readHistory(old);
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].action, h[0].toolVersion, h[0].templateVersion], ['generate', '0.0.9', '1']);

  const secret = 'sk-' + 'a'.repeat(40);
  const dirty = { history: ['x', null, { at: 5, action: 'rm -rf', mode: secret, changed: ['A.md', 7, secret], extra: 'ignored' }] };
  const c = readHistory(dirty);
  assert.equal(c.length, 1);
  assert.equal(c[0].at, null);
  assert.equal(c[0].action, 'generate');
  assert.ok(!JSON.stringify(c).includes(secret) && !('extra' in c[0]));
  assert.deepEqual(readHistory(null), []);
  assert.equal(readHistory({ history: Array.from({ length: 500 }, (_, i) => ({ at: String(i), action: 'apply' })) }).length, 200);
});
