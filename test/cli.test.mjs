// CLI の end-to-end (temp 内、ネットワークなし)。execFile は引数配列で shell を使わない。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTmp, cleanup, baseConfig, writeJson, readText } from './helpers.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cli.mjs');
const tmp = makeTmp('psw-cli-');
after(() => cleanup(tmp));

test('revise / copy は同じ変更をCLIで反映し、既存コピー先は明示退避する', async () => {
  const source = path.join(tmp, 'copy-source');
  const direct = path.join(tmp, 'copy-direct');
  const out = path.join(tmp, 'copy-output');
  for (const directory of [source, direct, out]) fs.mkdirSync(directory);
  for (const directory of [source, direct]) {
    fs.writeFileSync(path.join(directory, 'AGENTS.md'), '元のルール\n');
    fs.writeFileSync(path.join(directory, 'main.js'), 'code');
  }
  fs.writeFileSync(path.join(out, 'old.txt'), 'old');
  const changes = writeJson(path.join(tmp, 'changes.json'), { mode: 'codex-solo', ai: { codex: { model: 'gpt-6.1-sol', effort: 'low' } }, files: [{ path: 'AGENTS.md', content: '元のルール\n追記\n' }] });
  const args = ['copy', '--target', source, '--out', out, '--copy-scope', 'all', '--changes', changes, '--replace-output'];
  const preview = await cli(args);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(readText(path.join(out, 'old.txt')), 'old');
  const digest = preview.stdout.match(/確認用 digest: ([0-9a-f]{64})/)[1];
  const result = await cli([...args, '--confirm', digest]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readText(path.join(out, 'main.js')), 'code');
  assert.equal(readText(path.join(source, 'AGENTS.md')), '元のルール\n');
  assert.match(result.stdout, /旧コピー先の退避/);
  const directArgs = ['revise', '--target', direct, '--changes', changes];
  const planned = await cli(directArgs);
  const directDigest = planned.stdout.match(/確認用 digest: ([0-9a-f]{64})/)[1];
  const applied = await cli([...directArgs, '--confirm', directDigest]);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(readText(path.join(out, 'AGENTS.md')), readText(path.join(direct, 'AGENTS.md')));
});

// Codex acceptance-test repair: async execFile does not accept an input option.
// End stdin explicitly and bound every fixture process; never wait indefinitely.
async function cli(args, input) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 10000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

test('plan → generate → audit → regenerate の一連', async () => {
  const cfg = writeJson(path.join(tmp, 'c1.json'), baseConfig());
  const plan = await cli(['plan', '--config', cfg]);
  assert.equal(plan.code, 0);
  const digest = plan.stdout.match(/plan digest: ([0-9a-f]{64})/)[1];

  const out = path.join(tmp, 'out1');
  const bad = await cli(['generate', '--config', cfg, '--out', out, '--confirm', 'deadbeefdeadbeef']);
  assert.equal(bad.code, 1);
  assert.ok(/一致しません/.test(bad.stderr));
  assert.ok(!fs.existsSync(out));

  const un = await cli(['generate', '--config', cfg, '--out', out, '--confirm', digest, '--unattended']);
  assert.equal(un.code, 2);
  assert.ok(!fs.existsSync(out));

  const gen = await cli(['generate', '--config', cfg, '--out', out, '--confirm', digest]);
  assert.equal(gen.code, 0, gen.stderr);
  assert.ok(fs.existsSync(path.join(out, 'WORKFLOW.md')));

  const again = await cli(['generate', '--config', cfg, '--out', out, '--confirm', digest]);
  assert.equal(again.code, 1);
  assert.ok(/既に存在/.test(again.stderr));

  const audit = await cli(['audit', '--target', out]);
  assert.equal(audit.code, 0, audit.stdout);
  assert.ok(/検出数: 0/.test(audit.stdout));

  const cfg2 = writeJson(path.join(tmp, 'c2.json'), baseConfig({ mode: 'claude-led' }));
  const diff = await cli(['regenerate', '--config', cfg2, '--from', out]);
  assert.equal(diff.code, 0, diff.stderr);
  assert.ok(/WORKFLOW\.md: changed/.test(diff.stdout));
  const d2 = diff.stdout.match(/--confirm ([0-9a-f]{64})/)[1];
  const same = await cli(['regenerate', '--config', cfg2, '--from', out, '--out', out, '--confirm', d2]);
  assert.equal(same.code, 1);
  const out2 = path.join(tmp, 'out2');
  const regen = await cli(['regenerate', '--config', cfg2, '--from', out, '--out', out2, '--confirm', d2]);
  assert.equal(regen.code, 0, regen.stderr);
  assert.ok(/- 主導: Claude/.test(readText(path.join(out2, 'WORKFLOW.md'))));
  assert.ok(/- 主導: Codex/.test(readText(path.join(out, 'WORKFLOW.md'))), '元は不変');
});

test('必須未回答の plan は 2、秘密を含む設定は 1 で値を出さない', async () => {
  const cfg = writeJson(path.join(tmp, 'c-missing.json'), baseConfig({ purpose: '' }));
  const r = await cli(['plan', '--config', cfg]);
  assert.equal(r.code, 2);
  assert.ok(/要確認/.test(r.stdout));
  const secret = 'xo' + 'xb-' + '1234567890-abcdefghij';
  const cfgS = writeJson(path.join(tmp, 'c-s.json'), baseConfig({ notes: secret }));
  const s = await cli(['plan', '--config', cfgS]);
  assert.equal(s.code, 1);
  assert.ok(/秘密らしい/.test(s.stderr));
  assert.ok(!s.stderr.includes(secret) && !s.stdout.includes(secret));
});

test('questions --unattended は質問せず要確認を記録して 2', async () => {
  const out = path.join(tmp, 'q.json');
  const r = await cli(['questions', '--out', out, '--unattended']);
  assert.equal(r.code, 2);
  assert.ok(/無人モード/.test(r.stdout));
  assert.ok(!fs.existsSync(out));
});

test('questions 対話: 回答→要約→yes で JSON 保存、no なら保存しない', async () => {
  const out = path.join(tmp, 'q-yes.json');
  const answers = ['MyApp', '目的です', 'MVPです', '', '段階1', '', '', '', 'claude-solo', '', '', 'src/', '', '', 'yes'].join('\n') + '\n';
  const r = await cli(['questions', '--out', out], answers);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const saved = JSON.parse(readText(out));
  assert.equal(saved.mode, 'claude-solo');
  assert.deepEqual(saved.phases, ['段階1']);
  assert.deepEqual(saved.permissions.allowedPaths, ['src/']);
  const outNo = path.join(tmp, 'q-no.json');
  const no = await cli(['questions', '--out', outNo], answers.replace(/yes\n$/, 'no\n'));
  assert.equal(no.code, 2);
  assert.ok(!fs.existsSync(outNo));
});

test('audit --report は既存ファイルに書かない / update はオフラインで 2 (未確認あり)', async () => {
  const report = path.join(tmp, 'report.md');
  fs.writeFileSync(report, 'keep', 'utf8');
  const cfg = writeJson(path.join(tmp, 'c3.json'), baseConfig());
  const plan = await cli(['plan', '--config', cfg]);
  const digest = plan.stdout.match(/plan digest: ([0-9a-f]{64})/)[1];
  const out = path.join(tmp, 'out3');
  await cli(['generate', '--config', cfg, '--out', out, '--confirm', digest]);
  const a = await cli(['audit', '--target', out, '--report', report]);
  assert.equal(a.code, 1);
  assert.equal(readText(report), 'keep');
  const u = await cli(['update', '--json']);
  assert.equal(u.code, 2);
  const j = JSON.parse(u.stdout);
  assert.equal(j.online.enabled, false);
});
