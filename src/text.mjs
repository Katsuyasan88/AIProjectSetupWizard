// 自由文の扱い。ユーザー入力はデータであり、契約文と明確に分離して引用する。

// 制御文字 (改行・タブ以外) を除去
export function sanitizeText(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

// 単行化 (見出し等に使う)
export function oneLine(s) {
  return sanitizeText(s).replace(/\s*\n\s*/g, ' ').trim();
}

// Markdown 引用ブロックにする。空なら placeholder。
export function quoteBlock(s, placeholder = '(未記入)') {
  const t = sanitizeText(s).trim();
  if (t === '') return `> ${placeholder}`;
  return t
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

// 配列を引用リストにする
export function quoteList(items, placeholder = '(未記入)') {
  const arr = (items || []).map((x) => oneLine(x)).filter((x) => x !== '');
  if (arr.length === 0) return `> - ${placeholder}`;
  return arr.map((x) => `> - ${x}`).join('\n');
}

// 技術コマンド等を資料として保存する (実行しない) 用のコードブロック
export function codeBlock(lines, placeholder = '(未定)') {
  const arr = (lines || []).map((x) => sanitizeText(x).replace(/\n/g, ' ').trim()).filter((x) => x !== '');
  if (arr.length === 0) return `\`\`\`text\n${placeholder}\n\`\`\``;
  // コードブロック内でフェンスが閉じられないよう、``` を含む行は置換する
  const safe = arr.map((x) => x.replace(/```/g, '` ` `'));
  return `\`\`\`text\n${safe.join('\n')}\n\`\`\``;
}

export function sha256Hex(data) {
  // crypto は呼び出し側で import するのを避けるため、ここで動的に読む
  return cryptoHash(data);
}

import { createHash } from 'node:crypto';
function cryptoHash(data) {
  return createHash('sha256').update(data).digest('hex');
}

// キーをソートした決定的 JSON
export function stableStringify(value, indent = 0) {
  return JSON.stringify(sortKeys(value), null, indent);
}

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}
