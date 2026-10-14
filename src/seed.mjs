// おすすめの .gitignore を、ないときだけ作る (設定や manifest を持たない案件向けの単独の操作)。
// 生成済み・導入する案件では apply が同じことを行う。既にあれば内容を読まず、何もしない。
import fs from 'node:fs';
import path from 'node:path';
import { GITIGNORE_FILE_NAME } from './constants.mjs';
import { renderGitignore } from './render.mjs';
import { digestMatches } from './plan.mjs';
import { GenerateError } from './generate.mjs';
import { resolveLocal, isDirNoLink, lstatSafe } from './safepath.mjs';
import { sha256Hex } from './text.mjs';

export function planGitignore(targetDir) {
  const target = resolveLocal(targetDir, 'target');
  if (!isDirNoLink(target)) throw new GenerateError(`対象フォルダが存在しないか、リンクを経由しています: ${target}`);
  const content = renderGitignore();
  return {
    targetDir: target,
    exists: !!lstatSafe(path.join(target, GITIGNORE_FILE_NAME)),
    // .git があるか (存在だけを見る。中は読まない)
    gitPresent: !!lstatSafe(path.join(target, '.git')),
    content,
    // 対象と内容の両方を確認対象にする
    confirmDigest: sha256Hex(`gitignore|${target.toLowerCase()}|${sha256Hex(content)}`),
  };
}

export function writeGitignore({ targetDir, confirmDigest, unattended = false }) {
  if (unattended) throw new GenerateError('無人モード (--unattended) では作りません。');
  const report = planGitignore(targetDir);
  if (report.exists) throw new GenerateError(`${GITIGNORE_FILE_NAME} は既にあるため、何もしません (既存の内容は変えません)。`);
  if (!digestMatches(confirmDigest, report.confirmDigest)) {
    throw new GenerateError(`確認済み digest が一致しません。もう一度表示して確認し直してください。\n  期待: ${report.confirmDigest}`);
  }
  // wx: 確認のあとに誰かが作っていたら失敗する (上書きしない)
  fs.writeFileSync(path.join(report.targetDir, GITIGNORE_FILE_NAME), report.content, { encoding: 'utf8', flag: 'wx' });
  return report;
}

export function formatGitignoreReport(report) {
  const L = [`対象: ${report.targetDir}`];
  L.push(report.gitPresent ? '- git: 管理されています (.git がある)' : '- git: このフォルダは git 管理ではありません (.git がない)');
  if (report.exists) {
    L.push(`- ${GITIGNORE_FILE_NAME}: 既にあるので触りません`);
  } else {
    L.push(`- ${GITIGNORE_FILE_NAME}: ありません。次の内容で新しく作れます`, '', '```', report.content.trimEnd(), '```', '', `確認用 digest: ${report.confirmDigest}`);
  }
  return L.join('\n');
}
