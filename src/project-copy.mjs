// 案件一式を複製し、直接更新と同じ処理をコピー先に適用する。内容を評価・実行しない。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { resolveLocal, isInside, isDirNoLink, isRegularFileNoLink, isDeniedName, lstatSafe } from './safepath.mjs';
import { inspectOutputDirectory, GenerateError } from './generate.mjs';
import { planApply, applyToDir, formatApplyReport } from './apply.mjs';
import { planManagedEdits, applyManagedEdits, formatManagedReport } from './managed-edit.mjs';
import { digestMatches } from './plan.mjs';
import { sha256Hex, stableStringify } from './text.mjs';

// 大きな配信JSONや依存ファイルも、内容を出力せず固定サイズのバッファでハッシュする。
function fileHash(filename) {
  if (!isRegularFileNoLink(filename)) throw new GenerateError('コピー対象が通常ファイルでなくなりました');
  const descriptor = fs.openSync(filename, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const hash = createHash('sha256');
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}

export function inventoryProject(targetDir, scope) {
  if (!['all', 'safe'].includes(scope)) throw new GenerateError('コピー範囲を all / safe で明示してください');
  const target = resolveLocal(targetDir, 'target');
  if (!isDirNoLink(target)) throw new GenerateError('コピー元が存在しないかリンクを経由しています');
  const entries = [];
  const skipped = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      if (!isInside(target, absolute)) throw new GenerateError('コピー対象が案件外です');
      const relative = path.relative(target, absolute).split(path.sep).join('/');
      if (scope === 'safe' && (isDeniedName(name) || ['.venv', 'venv', '.psw-backup'].includes(name))) {
        skipped.push({ path: relative, reason: '選択したコピー範囲の対象外' });
        continue;
      }
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        skipped.push({ path: relative, reason: 'リンクを辿らない' });
      } else if (stat.isDirectory()) {
        if (!isDirNoLink(absolute)) throw new GenerateError('通常フォルダとして確認できないコピー対象です');
        entries.push({ path: relative, type: 'directory' });
        visit(absolute);
      } else if (stat.isFile()) {
        entries.push({ path: relative, type: 'file', size: stat.size, sha256: fileHash(absolute) });
      } else skipped.push({ path: relative, reason: '通常ファイル・フォルダ以外' });
    }
  }
  visit(target);
  return { target, entries, skipped, digest: sha256Hex(stableStringify({ entries, skipped })) };
}

function inspectCopyOutput(outDir, replaceOutput) {
  const out = resolveLocal(outDir, 'out');
  if (!replaceOutput || !lstatSafe(out)) return { ...inspectOutputDirectory(out), digest: null, replace: false };
  if (!isDirNoLink(out) || !isDirNoLink(path.dirname(out))) throw new GenerateError('出力先が通常フォルダでないかリンクを経由しています');
  const stat = fs.lstatSync(out);
  const inventory = inventoryProject(out, 'all');
  if (inventory.skipped.length) throw new GenerateError('置換する出力先にリンクなどがあります');
  const backupRoot = out + '.psw-backup';
  if (lstatSafe(backupRoot) && !isDirNoLink(backupRoot)) throw new GenerateError('出力先の退避先が通常フォルダではありません');
  return { out, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, digest: inventory.digest, replace: true, backupRoot };
}

export function planProjectCopy({ targetDir, outDir, scope, plan = null, changes = null, adopt = false, replace = [], replaceOutput = false }) {
  if (plan && changes) throw new GenerateError('--config と --changes は同時に使えません');
  const source = resolveLocal(targetDir, 'target');
  const proposedOut = resolveLocal(outDir, 'out');
  if (isInside(source, proposedOut) || isInside(proposedOut, source)) throw new GenerateError('コピー先は元の案件と別のフォルダにしてください');
  const proposedBackup = proposedOut + '.psw-backup';
  if (replaceOutput && (isInside(source, proposedBackup) || isInside(proposedBackup, source))) throw new GenerateError('コピー先の退避先が元の案件と重なります');
  const output = inspectCopyOutput(outDir, replaceOutput);
  if (isInside(source, output.out) || isInside(output.out, source)) throw new GenerateError('コピー先は元の案件と別のフォルダにしてください');
  const inventory = inventoryProject(source, scope);
  const update = plan ? planApply(plan, source, { adopt, replace }) : changes ? planManagedEdits(changes, source) : null;
  const kind = plan ? 'standard' : changes ? 'managed' : 'none';
  const basis = { source, out: output.out, scope, sourceDigest: inventory.digest, kind, updateDigest: update?.confirmDigest ?? null, adopt, replace: [...replace].sort(), replaceOutput, outputDigest: output.digest, outputIdentity: output.identity };
  return { source, out: output.out, scope, output, inventory, update, kind, blockers: update?.blockers ?? [], confirmDigest: sha256Hex('project-copy|' + stableStringify(basis)), fileCount: inventory.entries.filter(entry => entry.type === 'file').length, totalBytes: inventory.entries.reduce((total, entry) => total + (entry.size ?? 0), 0) };
}

export function copyProject({ targetDir, outDir, scope, plan = null, changes = null, adopt = false, replace = [], replaceOutput = false, confirmDigest, unattended = false, now = new Date().toISOString(), onCopy = null }) {
  if (unattended) throw new GenerateError('無人モードでは案件をコピーしません');
  const report = planProjectCopy({ targetDir, outDir, scope, plan, changes, adopt, replace, replaceOutput });
  if (report.blockers.length) throw new GenerateError('コピー先への更新を準備できません: ' + report.blockers.join(' / '));
  if (!digestMatches(confirmDigest, report.confirmDigest)) throw new GenerateError('コピー元・範囲・変更案・出力先の digest が一致しません');
  const parent = path.dirname(report.out);
  const stage = report.out + '.partial-' + process.pid + '-' + randomBytes(6).toString('hex');
  if (path.dirname(stage) !== parent || lstatSafe(stage)) throw new GenerateError('安全な一時出力先を作れません');
  fs.mkdirSync(stage);
  let removedEmpty = false;
  let outputBackupDir = null;
  try {
    for (const entry of report.inventory.entries) {
      const destination = path.resolve(stage, entry.path);
      if (!isInside(stage, destination)) throw new GenerateError('不正なコピー先パスです');
      if (entry.type === 'directory') fs.mkdirSync(destination);
      else {
        const source = path.resolve(report.source, entry.path);
        if (!isRegularFileNoLink(source)) throw new GenerateError('コピー中に元ファイルがリンクなどへ変わりました');
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        if (fileHash(destination) !== entry.sha256) throw new GenerateError('コピー中に元ファイルの内容が変わりました');
      }
      if (onCopy) onCopy(entry.path);
    }
    let updated = null;
    if (report.kind === 'standard') {
      const stagedReport = planApply(plan, stage, { adopt, replace });
      updated = applyToDir({ plan, targetDir: stage, confirmDigest: stagedReport.confirmDigest, adopt, replace, now });
    } else if (report.kind === 'managed') {
      const stagedReport = planManagedEdits(changes, stage);
      if (stagedReport.editDigest !== report.update.editDigest) throw new GenerateError('コピー先の文書が確認した変更案と一致しません');
      updated = applyManagedEdits({ changes, targetDir: stage, confirmDigest: stagedReport.confirmDigest, now });
    }
    if (inventoryProject(report.source, scope).digest !== report.inventory.digest) throw new GenerateError('コピー中に元の案件が変わったため停止します');
    const current = inspectCopyOutput(report.out, replaceOutput);
    if (current.identity !== report.output.identity || current.digest !== report.output.digest) throw new GenerateError('コピー中に出力先が変わったため停止します');
    if (current.replace) {
      fs.mkdirSync(current.backupRoot, { recursive: true });
      outputBackupDir = path.join(current.backupRoot, String(now).replace(/[^0-9TZ]/g, '') + '-' + randomBytes(6).toString('hex'));
      fs.renameSync(report.out, outputBackupDir);
    } else if (current.identity !== null) { fs.rmdirSync(report.out); removedEmpty = true; }
    fs.renameSync(stage, report.out);
    const backupDir = updated?.backupDir ? path.join(report.out, path.relative(stage, updated.backupDir)) : null;
    return { outDir: report.out, written: updated?.written ?? [], backupDir, outputBackupDir, copied: report.fileCount, skipped: report.inventory.skipped, confirmDigest: report.confirmDigest };
  } catch (error) {
    if (outputBackupDir && !lstatSafe(report.out) && isDirNoLink(outputBackupDir) && isDirNoLink(parent)) {
      try { fs.renameSync(outputBackupDir, report.out); } catch { /* 退避を保持して元のエラーを返す */ }
    }
    if (removedEmpty && !lstatSafe(report.out) && isDirNoLink(parent)) {
      try { fs.mkdirSync(report.out); } catch { /* 元のエラーを返す */ }
    }
    // 削除するのは、この処理が作った同じ親の一時フォルダだけ。
    if (path.dirname(stage) === parent && path.basename(stage).startsWith(path.basename(report.out) + '.partial-') && isDirNoLink(stage)) fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

export function formatProjectCopyReport(report) {
  const lines = [`コピー元: ${report.source}`, `コピー先: ${report.out}`, `コピー範囲: ${report.scope}`, `通常ファイル: ${report.fileCount} / 合計 ${report.totalBytes} bytes`, `確認用 digest: ${report.confirmDigest}`];
  if (report.output.replace) lines.push(`既存のコピー先は削除せず ${report.output.backupRoot}/<日時>/ へ退避して置き換えます。`);
  for (const item of report.inventory.skipped) lines.push(`- コピーしない: ${item.path} — ${item.reason}`);
  if (report.update) lines.push((report.kind === 'standard' ? formatApplyReport(report.update) : formatManagedReport(report.update)).replace('確認用 digest:', '文書更新単体の digest (コピー承認には使わない):'));
  lines.push('案件の内容を実行せず複製し、コピー先へ直接更新と同じ処理を適用します。コピー元は変更しません。');
  return lines.join('\n');
}
