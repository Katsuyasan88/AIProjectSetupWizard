import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAiPreferences, aiLaunchCommand } from '../src/ai-preferences.mjs';
import { validateConfig } from '../src/config.mjs';
import { buildPlan } from '../src/plan.mjs';
import { baseConfig } from './helpers.mjs';

test('旧設定は互換の既定値、両AIのモデル・effortを別に保存しdigestにも含める', () => {
  const old = buildPlan(validateConfig(baseConfig()));
  const ai = { codex: { model: 'gpt-6.1-sol', effort: 'low' }, claude: { model: 'opus', effort: 'max' } };
  const next = buildPlan(validateConfig(baseConfig({ ai })));
  assert.notEqual(next.digest, old.digest);
  assert.deepEqual(next.ai, { codex: { ...ai.codex, fallbackModels: [] }, claude: { ...ai.claude, fallbackModels: [] } });
  const start = next.files.find(file => file.path === 'START.md').content;
  assert.ok(start.includes('codex --model "gpt-6.1-sol"'));
  assert.ok(start.includes('model_reasoning_effort="low"'));
  assert.ok(start.includes('claude --model "opus" --effort max'));
  assert.ok(start.includes('文書の指示だけでは実行中のモデルは変わりません'));
});

test('単独モードの開始文には使用AIだけを出し、相手側の希望値は設定に保つ', () => {
  const plan = buildPlan(validateConfig(baseConfig({ mode: 'codex-solo', ai: { codex: { model: 'gpt-6.1-sol', effort: 'low' }, claude: { model: 'opus', effort: 'high' } } })));
  assert.equal(plan.ai.claude.model, 'opus');
  const start = plan.files.find(file => file.path === 'START.md').content;
  assert.ok(!start.includes('claude --model'));
  assert.ok(start.includes('codex --model'));
});

test('AIごとのeffort候補・既知の非対応組み合わせ・コマンド注入を拒否する', () => {
  assert.throws(() => normalizeAiPreferences({ claude: { effort: 'ultra' } }), /対応候補/);
  assert.throws(() => normalizeAiPreferences({ codex: { model: 'gpt-6.1-sol', effort: 'none' } }), /対応しない/);
  for (const model of ['gpt; echo injected', '$(evil)', '`evil`', 'x\nother-command', 'x" y']) assert.throws(() => normalizeAiPreferences({ codex: { model } }), /モデルID/);
  assert.equal(aiLaunchCommand('Codex', {}), 'codex');
  assert.equal(aiLaunchCommand('Claude', { claude: { model: 'opus[1m]', effort: 'high' } }), 'claude --model "opus[1m]" --effort high');
});
