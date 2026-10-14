#!/usr/bin/env node
// ProjectSetupWizard CLI (Node 22 標準ライブラリのみ)。shell コマンドは組み立てない。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EXIT, TOOL_NAME, TOOL_VERSION, CONFIG_FILE_NAME, MANIFEST_FILE_NAME, STANDARD_ELEMENTS, TEMPLATE_VERSION } from '../src/constants.mjs';
import { loadConfig, validateConfig, ConfigError } from '../src/config.mjs';
import { buildPlan, planSummary } from '../src/plan.mjs';
import { generateToDir, regenerateToDir, diffAgainstExisting, formatDiffReport, readHistory, GenerateError } from '../src/generate.mjs';
import { planApply, applyToDir, formatApplyReport } from '../src/apply.mjs';
import { planGitignore, writeGitignore, formatGitignoreReport } from '../src/seed.mjs';
import { auditTarget, renderAuditMarkdown, AuditError } from '../src/audit.mjs';
import { runUpdate, renderUpdateMarkdown } from '../src/update.mjs';
import { askQuestions, unattendedAnswers, answersToJson } from '../src/questions.mjs';
import { loadManagedChanges, planManagedEdits, applyManagedEdits, formatManagedReport } from '../src/managed-edit.mjs';
import { planProjectCopy, copyProject, formatProjectCopyReport } from '../src/project-copy.mjs';
import { resolveLocal, lstatSafe, isRegularFileNoLink, PathError } from '../src/safepath.mjs';
import { findExisting, toNative } from '../src/layout.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `${TOOL_NAME} v${TOOL_VERSION}

使い方: node scripts/cli.mjs <command> [options]

commands:
  questions   対話で質問し、確認後に設定 JSON を保存         --out <file> [--unattended]
  plan        設定から生成予定と digest を表示 (書き込みなし)  --config <file> [--json]
  generate    未作成または空のフォルダへ生成                 --config <file> --out <dir> --confirm <digest>
  regenerate  既存出力との差分を表示し、確認後に別の新規フォルダへ生成
                                                         --config <file> --from <dir> [--out <dir> --confirm <digest>] [--fresh]
              書き足された TASKS / VALIDATION は新しい出力へ引き継ぐ。--fresh は引き継がずテンプレートから作る
  apply       既存案件フォルダの管理文書を設定に合わせて直接更新 (差分確認 → digest 承認 → バックアップ付き)
                                                         --target <dir> [--config <file>] [--confirm <digest>]
              --adopt [--replace <a,b>]: このツールで生成していない案件へ導入。同名の既存ファイルは残し、--replace のものだけ置き換える
  revise      既存ルール優先の文書変更案を差分確認して反映   --target <dir> --changes <json> [--confirm <digest>]
  copy        案件一式を複製し、コピー先に同じ文書更新を適用 --target <dir> --out <dir> --copy-scope <all|safe>
                                                         [--changes <json> | --config <json> [--adopt] [--replace <a,b>]] [--confirm <digest>]
              all は .env・鍵・.git・依存も含む通常ファイル、safe はそれらを除外。リンクは辿らない。範囲は明示必須
              --replace-output は既存コピー先全体を隣の <out>.psw-backup/<日時>/ へ退避して置換する (digest承認必須)
  audit       指定案件の読取診断 (apply なし)                --target <dir> [--report <file>] [--json] [--unattended]
  gitignore   おすすめの .gitignore を、ないときだけ作る (既にあれば何もしない)。git 管理かどうかも表示
                                                         --target <dir> [--confirm <digest>]
  history     このツールが案件フォルダに対して行った生成・更新の記録を表示 (読むだけ)   --target <dir>
  standard    ウィザード標準 (生成文書が備える要素) の一覧を表示。既存の案件に足りない点を洗い出す物差し
  update      公式ドキュメントと確認済みの導入版の比較 (proposal のみ)
                                                         [--online] [--installed-version <v>] [--node-version <v>] [--report <file>] [--json] [--unattended]

共通: --unattended は質問を待たず要確認を記録し、生成しない。終了コード: 0 正常 / 1 エラー / 2 要確認。
`;

const OPTIONS = {
  config: { type: 'string' },
  changes: { type: 'string' },
  'copy-scope': { type: 'string' },
  'replace-output': { type: 'boolean', default: false },
  out: { type: 'string' },
  from: { type: 'string' },
  target: { type: 'string' },
  confirm: { type: 'string' },
  report: { type: 'string' },
  json: { type: 'boolean', default: false },
  unattended: { type: 'boolean', default: false },
  online: { type: 'boolean', default: false },
  fresh: { type: 'boolean', default: false },
  adopt: { type: 'boolean', default: false },
  replace: { type: 'string' },
  'installed-version': { type: 'string' },
  'node-version': { type: 'string' },
  'skills-dir': { type: 'string' },
  timeout: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
};

function need(values, key) {
  if (!values[key]) throw new UsageError(`--${key} が必要です`);
  return values[key];
}

class UsageError extends Error {}

// Skill の場所 (このリポジトリの .claude/skills の 1 か所だけ)
function defaultSkillsDir() {
  return path.join(REPO_ROOT, '.claude', 'skills');
}


// 新規ファイルとしてだけ書く (既存は上書きしない)
function writeNewFile(file, content) {
  const abs = resolveLocal(file, 'report');
  if (lstatSafe(abs)) throw new UsageError(`既存ファイルがあるため書きません: ${abs}`);
  fs.writeFileSync(abs, content, { encoding: 'utf8', flag: 'wx' });
  return abs;
}

function emitReport(values, markdown, json) {
  const text = values.json ? JSON.stringify(json, null, 2) + '\n' : markdown + '\n';
  if (values.report) {
    const abs = writeNewFile(values.report, text);
    process.stdout.write(`レポートを書きました: ${abs}\n`);
  } else {
    process.stdout.write(text);
  }
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const cmd = positionals[0];
  if (values.help || !cmd || cmd === 'help') {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  switch (cmd) {
    case 'questions': {
      const out = need(values, 'out');
      if (lstatSafe(resolveLocal(out, 'out'))) throw new UsageError(`既存ファイルがあるため書きません: ${out}`);
      if (values.unattended) {
        const r = unattendedAnswers();
        process.stdout.write('無人モード: 質問せず、必須未回答を要確認として記録します。設定は保存しません。\n');
        for (const n of r.needsConfirmation) process.stdout.write(`  - ${n.field}: ${n.message}\n`);
        return EXIT.NEEDS_CONFIRMATION;
      }
      let r;
      try {
        r = await askQuestions({});
      } catch (e) {
        throw new UsageError(`質問を完了できませんでした: ${e.message}`);
      }
      if (r.error) return EXIT.ERROR;
      if (!r.confirmed) {
        process.stdout.write('保存しませんでした (確認が yes ではない)。\n');
        return EXIT.NEEDS_CONFIRMATION;
      }
      const abs = writeNewFile(out, answersToJson(r.answers));
      process.stdout.write(`設定を保存しました: ${abs}\n次: node scripts/cli.mjs plan --config "${abs}"\n`);
      return r.validation.needsConfirmation.length ? EXIT.NEEDS_CONFIRMATION : EXIT.OK;
    }

    case 'plan': {
      const validated = loadConfig(need(values, 'config'));
      const plan = buildPlan(validated);
      if (values.json) {
        const { files, ...rest } = plan;
        process.stdout.write(JSON.stringify({ ...rest, files: files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })) }, null, 2) + '\n');
      } else {
        process.stdout.write(planSummary(plan) + '\n');
      }
      return plan.canGenerate ? EXIT.OK : EXIT.NEEDS_CONFIRMATION;
    }

    case 'generate': {
      const validated = loadConfig(need(values, 'config'));
      const plan = buildPlan(validated);
      const out = need(values, 'out');
      if (values.unattended) {
        process.stdout.write('無人モード: 生成しません。要確認:\n' + (plan.needsConfirmation.map((n) => `  - ${n.field}: ${n.message}`).join('\n') || '  - (必須は揃っているが、無人では承認を推測しない)') + '\n');
        return EXIT.NEEDS_CONFIRMATION;
      }
      const r = generateToDir({ plan, outDir: out, confirmDigest: values.confirm || '' });
      process.stdout.write([`生成しました: ${r.outDir}`, ...plan.files.map((x) => `  - ${x.path}`), ...(plan.seeds ?? []).map((x) => `  - ${x.path}`), `  - ${plan.manifestPath}`].join(String.fromCharCode(10)) + String.fromCharCode(10));
      return EXIT.OK;
    }

    case 'regenerate': {
      const validated = loadConfig(need(values, 'config'));
      const plan = buildPlan(validated);
      const report = diffAgainstExisting(plan, need(values, 'from'), { carry: !values.fresh });
      process.stdout.write(formatDiffReport(report) + '\n');
      if (!values.out) {
        process.stdout.write(`\n生成するには: --out <新規フォルダ> --confirm ${report.confirmDigest}${values.fresh ? ' --fresh' : ''}\n`);
        return plan.canGenerate ? EXIT.OK : EXIT.NEEDS_CONFIRMATION;
      }
      if (values.unattended) {
        process.stdout.write('無人モード: 生成しません。\n');
        return EXIT.NEEDS_CONFIRMATION;
      }
      const r = regenerateToDir({ plan, fromDir: values.from, outDir: values.out, confirmDigest: values.confirm || '', fresh: values.fresh });
      process.stdout.write(`別フォルダへ生成しました (比較元は不変): ${r.outDir}\n`);
      return EXIT.OK;
    }

    case 'apply': {
      // --config 省略時は対象フォルダ自身の設定を使う (文書を現在の設定へ合わせ直す)
      const target = need(values, 'target');
      if (values.adopt && !values.config) throw new UsageError('--adopt には --config が必要です (導入先の設定を対象の外に用意する)');
      const replace = values.replace ? values.replace.split(',').map((x) => x.trim()).filter(Boolean) : [];
      const opts = { adopt: values.adopt, replace };
      const validated = loadConfig(values.config || path.join(target, toNative(findExisting(resolveLocal(target, 'target'), CONFIG_FILE_NAME) ?? CONFIG_FILE_NAME)));
      const plan = buildPlan(validated);
      const report = planApply(plan, target, opts);
      process.stdout.write(formatApplyReport(report) + '\n');
      if (report.blockers.length) return EXIT.NEEDS_CONFIRMATION;
      if (report.nothingToDo) return EXIT.OK;
      if (!values.confirm) {
        process.stdout.write(`\n更新するには: ${values.adopt ? '--adopt ' : ''}${replace.length ? `--replace ${replace.join(',')} ` : ''}--confirm ${report.confirmDigest}\n`);
        return plan.canGenerate ? EXIT.OK : EXIT.NEEDS_CONFIRMATION;
      }
      if (values.unattended) {
        process.stdout.write('無人モード: 更新しません。\n');
        return EXIT.NEEDS_CONFIRMATION;
      }
      const r = applyToDir({ plan, targetDir: target, confirmDigest: values.confirm, ...opts });
      const lines = [`更新しました: ${r.targetDir}`, ...r.written.map((p) => `  - ${p}`), ...r.moved.map((p) => `  - ${p} (バックアップへ移動)`), `変更前のバックアップ: ${r.backupDir}`];
      process.stdout.write(lines.join('\n') + '\n');
      return EXIT.OK;
    }

    case 'revise': {
      const changes = loadManagedChanges(need(values, 'changes'));
      const report = planManagedEdits(changes, need(values, 'target'));
      process.stdout.write(formatManagedReport(report) + '\n');
      if (!values.confirm || report.nothingToDo) return EXIT.OK;
      const result = applyManagedEdits({ changes, targetDir: values.target, confirmDigest: values.confirm, unattended: values.unattended });
      process.stdout.write(`更新しました: ${result.targetDir}\nバックアップ: ${result.backupDir}\n`);
      return EXIT.OK;
    }

    case 'copy': {
      const options = {
        targetDir: need(values, 'target'), outDir: need(values, 'out'), scope: need(values, 'copy-scope'),
        plan: values.config ? buildPlan(loadConfig(values.config)) : null,
        changes: values.changes ? loadManagedChanges(values.changes) : null,
        adopt: values.adopt, replace: values.replace ? values.replace.split(',').map(name => name.trim()).filter(Boolean) : [],
        replaceOutput: values['replace-output'],
      };
      const report = planProjectCopy(options);
      process.stdout.write(formatProjectCopyReport(report) + '\n');
      if (report.blockers.length) return EXIT.NEEDS_CONFIRMATION;
      if (!values.confirm) return EXIT.OK;
      const result = copyProject({ ...options, confirmDigest: values.confirm, unattended: values.unattended });
      process.stdout.write(`案件をコピーして更新しました: ${result.outDir}\n複製した通常ファイル: ${result.copied}\nバックアップ: ${result.backupDir ?? '(更新なし)'}\n`);
      if (result.outputBackupDir) process.stdout.write(`旧コピー先の退避: ${result.outputBackupDir}\n`);
      return EXIT.OK;
    }

    case 'audit': {
      const report = auditTarget(need(values, 'target'), { unattended: values.unattended });
      emitReport(values, renderAuditMarkdown(report), report);
      return report.findings.length ? EXIT.NEEDS_CONFIRMATION : EXIT.OK;
    }

    case 'gitignore': {
      const target = need(values, 'target');
      const report = planGitignore(target);
      process.stdout.write(formatGitignoreReport(report) + String.fromCharCode(10));
      if (report.exists) return EXIT.OK;
      if (!values.confirm) {
        process.stdout.write(`作るには: --confirm ${report.confirmDigest}` + String.fromCharCode(10));
        return EXIT.OK;
      }
      if (values.unattended) {
        process.stdout.write('無人モード: 作りません。' + String.fromCharCode(10));
        return EXIT.NEEDS_CONFIRMATION;
      }
      writeGitignore({ targetDir: target, confirmDigest: values.confirm });
      process.stdout.write('作りました: .gitignore' + String.fromCharCode(10));
      return EXIT.OK;
    }

    case 'history': {
      const historyTarget = resolveLocal(need(values, 'target'), 'target');
      const file = path.join(historyTarget, toNative(findExisting(historyTarget, MANIFEST_FILE_NAME) ?? MANIFEST_FILE_NAME));
      if (!isRegularFileNoLink(file)) throw new UsageError(`${MANIFEST_FILE_NAME} がありません (このツールで生成・導入した案件フォルダを指定してください)`);
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new UsageError(`${MANIFEST_FILE_NAME} を解析できません`);
      }
      const label = { generate: '新規生成', regenerate: '別フォルダへ生成', apply: '更新', adopt: '導入' };
      const out = readHistory(manifest).map((h) => {
        const parts = [`${h.at ?? '?'}  ${label[h.action] ?? h.action}  ツール ${h.toolVersion ?? '?'} / テンプレート ${h.templateVersion ?? '?'} / ${h.mode ?? '?'}`];
        if (h.changed.length) parts.push(`    書いた: ${h.changed.join(', ')}`);
        if (h.moved.length) parts.push(`    退避した: ${h.moved.join(', ')}`);
        if (h.kept.length) parts.push(`    残した・引き継いだ: ${h.kept.join(', ')}`);
        return parts.join(String.fromCharCode(10));
      });
      process.stdout.write((out.length ? out.join(String.fromCharCode(10)) : '記録がありません。') + String.fromCharCode(10));
      return EXIT.OK;
    }

    case 'standard': {
      const lines = [`ウィザード標準 (template ${TEMPLATE_VERSION}) の要素:`, ...STANDARD_ELEMENTS.map((e, i) => `${i + 1}. [${e.id}]${e.profile ? ` (${e.profile} 以上)` : ''}${e.setting ? ` (設定 ${e.setting} を選んだとき)` : ''} ${e.title}`)];
      process.stdout.write(lines.join(String.fromCharCode(10)) + String.fromCharCode(10));
      return EXIT.OK;
    }

    case 'update': {
      const report = await runUpdate({
        online: values.online,
        installedVersion: values['installed-version'] || null,
        nodeVersion: values['node-version'] || null,
        skillsDir: values['skills-dir'] || defaultSkillsDir(),
        timeoutMs: values.timeout ? Number(values.timeout) : 8000,
        unattended: values.unattended,
      });
      emitReport(values, renderUpdateMarkdown(report), report);
      return report.needsConfirmation.length ? EXIT.NEEDS_CONFIRMATION : EXIT.OK;
    }

    default:
      throw new UsageError(`不明なコマンド: ${cmd}\n${HELP}`);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    if (e instanceof ConfigError || e instanceof GenerateError || e instanceof AuditError || e instanceof UsageError || e instanceof PathError) {
      process.stderr.write(`エラー: ${e.message}\n`);
    } else {
      process.stderr.write(`予期しないエラー: ${e?.stack || e}\n`);
    }
    process.exitCode = EXIT.ERROR;
  });
