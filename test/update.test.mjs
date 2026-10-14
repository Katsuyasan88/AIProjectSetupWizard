import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runUpdate, renderUpdateMarkdown, parseFrontmatter, inspectSkills } from '../src/update.mjs';
import { OFFICIAL_URLS } from '../src/constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(ROOT, '.claude', 'skills');

const failingFetch = async () => {
  throw new Error('network disabled in tests');
};

test('配布 Skill 4 つは name/description を持ち、未採用機能を使わない', () => {
  const r = inspectSkills(SKILLS);
  assert.deepEqual(r.problems, []);
  const names = r.skills.map((s) => s.name).sort();
  assert.deepEqual(names, ['project-audit', 'project-change', 'project-new', 'project-update']);
  // 書き込みを伴う Skill は明示操作でのみ起動する
  const explicitOnly = ['project-new', 'project-change'];
  for (const s of r.skills) {
    if (explicitOnly.includes(s.name)) assert.equal(s.disableModelInvocation, 'true', `${s.name} は明示操作のみ`);
    else assert.equal(s.disableModelInvocation, null, `${s.name} は default`);
    assert.deepEqual(s.notAdoptedUsed, []);
  }
});

test('frontmatter 解析', () => {
  assert.deepEqual(parseFrontmatter('---\nname: x\ndescription: y z\n---\nbody'), { name: 'x', description: 'y z' });
  assert.equal(parseFrontmatter('no fm'), null);
});

test('オフライン: ネットワークを使わず、未申告の導入版は未確認', async () => {
  const r = await runUpdate({ online: false, skillsDir: SKILLS, fetchImpl: failingFetch });
  assert.equal(r.online.results.length, 0);
  assert.equal(r.installed.claudeCliStatus, 'unverified');
  assert.ok(r.needsConfirmation.some((n) => /未確認|確認していない/.test(n)));
  const md = renderUpdateMarkdown(r);
  assert.ok(/proposal のみ/.test(md));
  assert.ok(!/[w.+-]+@[w-]+.[w.-]+/.test(md) && !/Users[\/]/.test(md), '個人識別情報 (メールアドレスやホームのパス) を含めない');
});

test('申告版が基準の版と一致すれば same-as-baseline、異なれば要確認', async () => {
  const a = await runUpdate({ installedVersion: '2.1.288', nodeVersion: 'v22.20.0', skillsDir: SKILLS, fetchImpl: failingFetch });
  assert.equal(a.installed.claudeCliStatus, 'same-as-baseline');
  const b = await runUpdate({ installedVersion: '2.2.0', skillsDir: SKILLS, fetchImpl: failingFetch });
  assert.equal(b.installed.claudeCliStatus, 'differs-from-baseline');
  assert.ok(b.needsConfirmation.some((n) => /異なる/.test(n)));
});

test('オンライン (偽 fetch): allowlist のみ、失敗/タイムアウト/リダイレクトは未確認、読めても対応と断定しない', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push(url);
    assert.equal(opts.redirect, 'manual');
    if (url.endsWith('/skills')) {
      return { ok: true, status: 200, text: async () => '<html>name: description: disable-model-invocation context: fork allowed-tools</html>' };
    }
    if (url.endsWith('/commands')) return { ok: false, status: 302, text: async () => '' };
    return new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
  };
  const r = await runUpdate({ online: true, skillsDir: SKILLS, fetchImpl: fakeFetch, timeoutMs: 50, unattended: true });
  assert.deepEqual(calls.sort(), OFFICIAL_URLS.map((u) => u.url).sort());
  const byId = Object.fromEntries(r.online.results.map((x) => [x.id, x]));
  assert.equal(byId.skills.status, 'ok');
  assert.equal(byId.commands.status, 'unverified');
  assert.equal(byId.memory.status, 'unverified');
  assert.ok(/タイムアウト/.test(byId.memory.reason));
  assert.ok(r.needsConfirmation.length >= 2);
  const md = renderUpdateMarkdown(r);
  assert.ok(/導入版が対応するかは別途確認/.test(md));
  assert.ok(/未採用機能の記述あり/.test(md));
  assert.ok(/保留/.test(md));
});

test('Codex 用の入口 (.agents/skills) が本体 (.claude/skills) と揃っている', async () => {
  const { buildAgentSkillFiles, checkAgentSkills } = await import('../scripts/sync-agent-skills.mjs');
  assert.deepEqual(checkAgentSkills(), [], '食い違いあり。node scripts/sync-agent-skills.mjs を実行する');
  const files = buildAgentSkillFiles();
  const source = inspectSkills(SKILLS);
  for (const s of source.skills) {
    const stub = files.get(path.join(s.name, 'SKILL.md'));
    const fm = parseFrontmatter(stub);
    assert.equal(fm.name, s.name);
    assert.ok(fm.description && stub.includes(`.claude/skills/${s.name}/SKILL.md`), s.name);
    assert.ok(!/disable-model-invocation|allowed-tools|context:/.test(stub), `${s.name}: Claude Code 専用の指定を入口に持ち込まない`);
    // 書き込みを伴う Skill は、Codex でも明示操作のときだけ
    const yaml = files.get(path.join(s.name, 'agents', 'openai.yaml'));
    if (s.disableModelInvocation === 'true') assert.ok(/allow_implicit_invocation: false/.test(yaml), s.name);
    else assert.equal(yaml, undefined, s.name);
  }
});

test('Skill の手順は特定の AI を名指しで前提にしない (あなた = 実行している AI)', () => {
  for (const s of inspectSkills(SKILLS).skills) {
    const text = fs.readFileSync(path.join(SKILLS, s.name, 'SKILL.md'), 'utf8');
    assert.ok(!/あなた (Claude)/.test(text), s.name);
  }
});
