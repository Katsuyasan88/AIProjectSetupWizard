// plan: 設定から生成予定ファイルと digest を決定的に計算する (書き込みなし)。
import { MODES, ENTRY_FILE, TEMPLATE_VERSION, CONFIG_FILE_NAME, RULES_FILE_NAME, GITIGNORE_FILE_NAME } from './constants.mjs';
import { hasRequiredMissing } from './config.mjs';
import { layoutOf, placeOf, applyLayout } from './layout.mjs';
import { MANIFEST_FILE_NAME } from './constants.mjs';
import { sha256Hex, stableStringify } from './text.mjs';
import {
  renderProject,
  renderWorkflow,
  renderEntry,
  renderStart,
  renderTasks,
  renderValidation,
  renderRules,
  renderGitignore,
  hasProjectRules,
  hasHandover,
} from './render.mjs';
import { isStandard, isFull, profileOf, extendWorkflow, extendEntry, useTaskIds, finalizeDocument, extendMinimalTasks, pushPolicyOf, launchPolicyOf, renderTasksProfile, renderContext, renderUserTests, renderBacklog, CONTEXT_FILE_NAME, USER_TESTS_FILE_NAME, BACKLOG_FILE_NAME } from './render-profile.mjs';

// validated = validateConfig() の戻り値
export function buildPlan(validated) {
  const { config: cfg, needsConfirmation, undecided, warnings } = validated;
  const meta = { needsConfirmation, undecided };
  const files = [];
  const canGenerate = !hasRequiredMissing(needsConfirmation) && !!cfg.mode;

  files.push({ path: CONFIG_FILE_NAME, content: stableStringify(cfg, 2) + '\n' });
  files.push({ path: 'PROJECT.md', content: renderProject(cfg, meta) });
  if (cfg.mode) {
    const m = MODES[cfg.mode];
    const std = isStandard(cfg);
    files.push({ path: 'WORKFLOW.md', content: extendWorkflow(renderWorkflow(cfg), cfg) });
    if (hasProjectRules(cfg)) files.push({ path: RULES_FILE_NAME, content: renderRules(cfg) });
    files.push({ path: 'TASKS.md', content: std ? renderTasksProfile(cfg, meta, { hasHandover: hasHandover(cfg) }) : extendMinimalTasks(renderTasks(cfg, meta)) });
    files.push({ path: 'VALIDATION.md', content: std ? useTaskIds(renderValidation(cfg)) : renderValidation(cfg) });
    if (std) {
      files.push({ path: CONTEXT_FILE_NAME, content: renderContext(cfg) });
      files.push({ path: USER_TESTS_FILE_NAME, content: renderUserTests() });
    }
    if (isFull(cfg)) files.push({ path: BACKLOG_FILE_NAME, content: renderBacklog() });
    for (const agent of m.agents) {
      files.push({ path: ENTRY_FILE[agent], content: extendEntry(renderEntry(cfg, agent), cfg, agent) });
    }
    files.push({ path: 'START.md', content: std ? useTaskIds(renderStart(cfg)) : renderStart(cfg) });
  }
  for (const f of files) {
    if (f.path.endsWith('.md') && f.path !== 'PROJECT.md' && f.path !== RULES_FILE_NAME) f.content = finalizeDocument(f.content, cfg);
  }
  // 配置 (docs/ と initial-settings/) を適用する。ここより前は、ルート前提の名前とリンクで組み立てている。
  const layout = layoutOf(cfg);
  applyLayout(files, layout);
  // seeds: ないときだけ作るファイル。既にあれば比較も上書きもしない。manifest の files には入れない。
  const seeds = cfg.gitignore === false ? [] : [{ path: GITIGNORE_FILE_NAME, content: renderGitignore() }];
  for (const f of [...files, ...seeds]) {
    f.sha256 = sha256Hex(f.content);
    f.bytes = Buffer.byteLength(f.content, 'utf8');
  }
  const digest = computeDigest(files, seeds);
  return {
    templateVersion: TEMPLATE_VERSION,
    mode: cfg.mode,
    profile: profileOf(cfg),
    pushPolicy: pushPolicyOf(cfg),
    launchPolicy: launchPolicyOf(cfg),
    uiRules: cfg.uiRules === true,
    layout,
    manifestPath: placeOf(MANIFEST_FILE_NAME, layout),
    handoff: cfg.handoff,
    ai: cfg.ai,
    files,
    seeds,
    digest,
    canGenerate,
    needsConfirmation,
    undecided,
    warnings,
  };
}

export function computeDigest(files, seeds = []) {
  const basis = {
    templateVersion: TEMPLATE_VERSION,
    files: files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    seeds: seeds.map((f) => ({ path: f.path, sha256: f.sha256 })),
  };
  return sha256Hex(stableStringify(basis));
}

// 確認済み digest と計画 digest の一致 (16 文字以上の前方一致を許す)
export function digestMatches(given, actual) {
  if (typeof given !== 'string') return false;
  const g = given.trim().toLowerCase();
  if (!/^[0-9a-f]{16,64}$/.test(g)) return false;
  return actual.startsWith(g);
}

export function planSummary(plan) {
  const lines = [];
  lines.push(`mode: ${plan.mode || '(未回答)'}  handoff: ${plan.handoff}  profile: ${plan.profile}  push: ${plan.pushPolicy === 'work-branch' ? '作業ブランチへは承認なし' : '毎回承認'}  別AIの起動: ${plan.launchPolicy === 'lead-launch' ? '主導担当が範囲内で起動してよい' : '毎回承認'}  画面の決まり: ${plan.uiRules ? '入れる' : '入れない'}`);
  for (const agent of MODES[plan.mode]?.agents ?? []) {
    const preference = plan.ai?.[agent.toLowerCase()];
    lines.push(`${agent}: model ${preference?.model || '(既定)'} / effort ${preference?.effort || '(既定)'}${preference?.fallbackModels?.length ? ` / 代わり ${preference.fallbackModels.join(' → ')}` : ''}`);
  }
  lines.push(`plan digest: ${plan.digest}`);
  for (const s of plan.seeds ?? []) lines.push(`ないときだけ作る: ${s.path} (${s.bytes} bytes)`);
  lines.push('files:');
  for (const f of plan.files) lines.push(`  - ${f.path} (${f.bytes} bytes, sha256 ${f.sha256.slice(0, 12)})`);
  if (plan.warnings?.length) {
    lines.push('warnings:');
    for (const w of plan.warnings) lines.push(`  - ${w}`);
  }
  if (plan.needsConfirmation.length) {
    lines.push('要確認:');
    for (const n of plan.needsConfirmation) lines.push(`  - ${n.field}: ${n.message}`);
  }
  if (plan.undecided.length) lines.push(`未定 (生成は可): ${plan.undecided.join(', ')}`);
  lines.push(plan.canGenerate ? '生成可: はい (generate --confirm <digest> で実行)' : '生成可: いいえ (必須の要確認を解消してください)');
  return lines.join('\n');
}
