// パス安全化。shell を使わず fs API だけで扱う。
// リンク (symlink / junction / reparse point) は最終成分だけでなく中間成分も拒否する。
import path from 'node:path';
import fs from 'node:fs';

export class PathError extends Error {}

export function isUncPath(p) {
  return /^[\\/]{2}/.test(String(p));
}

// 解決済み絶対パスを返す。UNC は拒否。
export function resolveLocal(p, label = 'path') {
  if (typeof p !== 'string' || p.trim() === '') {
    throw new PathError(`${label}: 空のパスは使えません`);
  }
  if (isUncPath(p)) {
    throw new PathError(`${label}: UNC パスは扱いません`);
  }
  // 制御文字は拒否
  if (/[\u0000-\u001f]/.test(p)) {
    throw new PathError(`${label}: 制御文字を含むパスは使えません`);
  }
  const abs = path.resolve(p);
  if (isUncPath(abs)) throw new PathError(`${label}: UNC パスは扱いません`);
  return abs;
}

// child が base の内側 (または base 自身) か
export function isInside(base, child) {
  const rel = path.relative(base, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// symlink / junction / reparse point を追わない lstat (最終成分のみ)
export function lstatSafe(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// ルート直下から各成分を lstat し、どこかにリンクがあれば true。
// 存在しない成分に達したら、それ以降は検査できないので false (存在確認は別に行う)。
export function hasLinkComponent(absPath) {
  const parsed = path.parse(absPath);
  let cur = parsed.root;
  const rel = absPath.slice(parsed.root.length);
  for (const seg of rel.split(/[\\/]+/)) {
    if (!seg) continue;
    cur = path.join(cur, seg);
    const st = lstatSafe(cur);
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

// realpath と一致しない = どこかでリンクを経由している
export function realpathMatches(absPath) {
  try {
    const real = fs.realpathSync.native(absPath);
    return path.resolve(real).toLowerCase() === path.resolve(absPath).toLowerCase();
  } catch {
    return false;
  }
}

// 中間成分も含めてリンクがなく、通常ファイルであること
export function isRegularFileNoLink(p) {
  const st = lstatSafe(p);
  if (!st || !st.isFile() || st.isSymbolicLink()) return false;
  if (hasLinkComponent(p)) return false;
  return realpathMatches(p);
}

// 中間成分も含めてリンクがなく、通常ディレクトリであること
export function isDirNoLink(p) {
  const st = lstatSafe(p);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return false;
  if (hasLinkComponent(p)) return false;
  return realpathMatches(p);
}

// 読まないファイル/ディレクトリ名 (秘密・認証・依存)
const DENY_NAMES = [
  /^\.env(\..*)?$/i,
  /^\.git$/i,
  /^node_modules$/i,
  /^\.ssh$/i,
  /^\.aws$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /credential/i,
  /secret/i,
  /token/i,
];

export function isDeniedName(name) {
  return DENY_NAMES.some((re) => re.test(name));
}

// 相対パスの各セグメントに拒否名が含まれるか
export function hasDeniedSegment(relPath) {
  return relPath.split(/[\\/]+/).some((seg) => seg && isDeniedName(seg));
}

// 絶対パスの (ルートを除く) 各セグメントに拒否名が含まれるか
export function hasDeniedSegmentAbs(absPath) {
  const parsed = path.parse(absPath);
  return hasDeniedSegment(absPath.slice(parsed.root.length));
}
