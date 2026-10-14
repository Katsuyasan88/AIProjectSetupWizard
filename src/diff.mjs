// 行単位の簡易差分 (LCS)。外部依存なし。
const MAX_CELLS = 4_000_000;

export function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length * b.length > MAX_CELLS) {
    // 大きすぎる場合は全置換として扱う
    return [...a.map((l) => ({ op: '-', line: l })), ...b.map((l) => ({ op: '+', line: l }))];
  }
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: '-', line: a[i] });
      i++;
    } else {
      out.push({ op: '+', line: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ op: '-', line: a[i++] });
  while (j < m) out.push({ op: '+', line: b[j++] });
  return out;
}

function splitLines(text) {
  if (text === '' || text === undefined || text === null) return [];
  const s = String(text).replace(/\r\n?/g, '\n');
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// unified 風テキスト (文脈 3 行)
export function formatDiff(oldText, newText, { oldLabel = 'a', newLabel = 'b', context = 3 } = {}) {
  const ops = diffLines(oldText, newText);
  if (ops.every((o) => o.op === ' ')) return '';
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].op !== ' ') {
      for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) keep[c] = true;
    }
  }
  const lines = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  let inGap = false;
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) {
      if (!inGap) {
        lines.push('@@ ... @@');
        inGap = true;
      }
      continue;
    }
    inGap = false;
    lines.push(`${ops[k].op}${ops[k].line}`);
  }
  return lines.join('\n');
}

export function countChanges(oldText, newText) {
  const ops = diffLines(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.op === '+') added++;
    else if (o.op === '-') removed++;
  }
  return { added, removed };
}
