// 開発用と本番用 (envSplit): 任意。分けると、正本・入口・初期確認・CONTEXT に入る。staging などの中間の環境は扱わない。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { buildPlan, planSummary } from '../src/plan.mjs';
import { generateToDir } from '../src/generate.mjs';
import { auditTarget } from '../src/audit.mjs';
import { settingFollowups } from '../src/followup.mjs';
import { MODES, MODE_NAMES, ENTRY_FILE, STANDARD_ELEMENTS } from '../src/constants.mjs';
import { PROFILES } from '../src/render-profile.mjs';
import { makeTmp, cleanup, baseConfig } from './helpers.mjs';

const tmp = makeTmp();
after(() => cleanup(tmp));

const planFor = (mode, profile, ov = {}) => buildPlan(validateConfig(baseConfig({ mode, handoff: MODES[mode].solo ? undefined : 'manual', profile, ...ov })));
const fileOf = (plan, name) => plan.files.find((f) => f.path === name)?.content ?? null;
const all = (plan) => plan.files.filter((f) => f.path.endsWith('.md')).map((f) => f.content).join('\n');
let seq = 0;
function gen(plan) {
  const dir = path.join(tmp, `e${++seq}`);
  generateToDir({ plan, outDir: dir, confirmDigest: plan.digest });
  return dir;
}

test('開発用と本番用: 既定では入らない。真偽以外は拒否する', () => {
  assert.equal(validateConfig(baseConfig()).config.envSplit, false);
  assert.throws(() => validateConfig(baseConfig({ envSplit: 'yes' })), /envSplit/);
  const off = planFor('codex-led', 'full');
  assert.ok(!all(off).includes('## 開発用と本番用'));
  assert.match(planSummary(off), /開発用と本番用: 分けない/);
  // しっかりの段階では、これまでどおり「公開・費用・引き継ぎ」に分離の決まりがある
  assert.match(fileOf(off, 'WORKFLOW.md'), /開発用と本番用で、認証・データ・接続先/);
});

test('開発用と本番用: 分けると、全モード・全段階の正本・入口・初期確認に入り、監査の指摘は出ない', () => {
  const element = STANDARD_ELEMENTS.find((e) => e.id === 'env-split');
  assert.equal(element.setting, 'envSplit');
  for (const mode of MODE_NAMES) {
    for (const profile of PROFILES) {
      const plan = planFor(mode, profile, { envSplit: true });
      const wf = fileOf(plan, 'WORKFLOW.md');
      assert.ok(wf.includes(element.marker), `${mode} ${profile}`);
      assert.ok(wf.includes('認証・設定・接続先・データ・秘密情報・ログを分け'), '既存のしっかりの決まりと同じものを分ける');
      assert.ok(!/staging|ステージング/i.test(wf), 'staging は扱わない');
      for (const agent of MODES[mode].agents) assert.match(fileOf(plan, ENTRY_FILE[agent]), /本番に触れる前/);
      assert.match(fileOf(plan, 'TASKS.md'), /開発用と本番用: それぞれの場所と切り替え方/);
      assert.match(planSummary(plan), /開発用と本番用: 分ける/);
      if (profile !== 'minimal') assert.match(fileOf(plan, 'CONTEXT.md'), /## 開発用と本番用の場所・切り替え方/);
      if (profile === 'full') {
        assert.match(wf, /開発用と本番用の扱いは「開発用と本番用」による/);
        assert.ok(!wf.includes('開発用と本番用で、認証・データ・接続先'), '同じ決まりを二重に書かない');
      }
      assert.deepEqual(auditTarget(gen(plan)).findings, [], `${mode} ${profile}`);
    }
  }
});

test('更新後の対応: 分けることにしたときだけ並べる', () => {
  const cfg = (ov) => validateConfig(baseConfig({ profile: 'standard', ...ov })).config;
  assert.deepEqual(settingFollowups(cfg({ envSplit: true }), cfg({ envSplit: true })), []);
  assert.deepEqual(settingFollowups(cfg({ envSplit: true }), cfg({ envSplit: false })), []);
  const on = settingFollowups(cfg({}), cfg({ envSplit: true }));
  assert.equal(on.length, 2);
  assert.match(on[0], /CONTEXT\.md に書く/);
});
