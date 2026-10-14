#!/usr/bin/env node
// Codex 用の Skill の入口 (.agents/skills) を、手順の本体 (.claude/skills) から作る。
// 手順は 1 か所 (.claude/skills/<name>/SKILL.md) にだけ書き、Codex 側には本体を読むよう案内する短い入口だけを置く。
//   node scripts/sync-agent-skills.mjs          入口を書き出す
//   node scripts/sync-agent-skills.mjs --check  入口が最新か確かめる (違えば終了コード 1)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../src/update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_DIR = path.join(ROOT, '.claude', 'skills');
export const AGENTS_DIR = path.join(ROOT, '.agents', 'skills');

// 入口として出力するファイル (相対パス → 内容) を、本体から組み立てる
export function buildAgentSkillFiles(sourceDir = SOURCE_DIR) {
  const files = new Map();
  for (const ent of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    const fm = parseFrontmatter(fs.readFileSync(path.join(sourceDir, name, 'SKILL.md'), 'utf8'));
    if (!fm?.name || !fm?.description) throw new Error(`${name}: 本体の SKILL.md に name / description がない`);
    const explicitOnly = fm['disable-model-invocation'] === 'true';
    const lines = [
      '---',
      `name: ${fm.name}`,
      `description: ${fm.description}`,
      '---',
      '',
      `# ${fm.name} (Codex 用の入口)`,
      '',
      `この Skill の手順の本体は \`.claude/skills/${name}/SKILL.md\` にあります。まずそのファイルを最後まで読み、そこに書かれた原則と手順にそのまま従ってください。`,
      'Claude Code と Codex で同じ手順を使うため、ここには複製を置いていません。このファイルは `node scripts/sync-agent-skills.mjs` が作るので、直接は編集しません。',
      '',
      '## 読み替え',
      '',
      `- 本文の \`/${name}\` は、Codex では \`$${name}\` と打つか、\`/skills\` から選ぶ操作にあたります。`,
      '- 本文の「質問ウィンドウ (AskUserQuestion)」が使えない環境では、同じ質問と選択肢を番号付きで会話に示し、番号か自由記述で答えてもらいます。1 回に聞くのは 4 問までで、選択肢の内容は変えません。回答は承認ではない、という扱いも同じです。',
      '- 本文の「あなた」は、この Skill を実行している AI を指します。',
      '- CLI は、このリポジトリの直下で `node scripts/cli.mjs ...` として実行します。',
    ];
    if (explicitOnly) lines.push('- この Skill は書き込みを伴います。ユーザーが明示的に呼んだときだけ使い、自分の判断では使いません。');
    files.set(path.join(name, 'SKILL.md'), lines.join('\n') + '\n');
    // 書き込みを伴う Skill は、Codex でも明示操作のときだけ動くようにする
    if (explicitOnly) files.set(path.join(name, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  }
  return files;
}

// 入口の現状と、あるべき内容の食い違い (なければ空)
export function checkAgentSkills(sourceDir = SOURCE_DIR, agentsDir = AGENTS_DIR) {
  const problems = [];
  const files = buildAgentSkillFiles(sourceDir);
  for (const [rel, content] of files) {
    const p = path.join(agentsDir, rel);
    if (!fs.existsSync(p)) problems.push(`ない: ${rel}`);
    else if (fs.readFileSync(p, 'utf8') !== content) problems.push(`古い: ${rel}`);
  }
  if (fs.existsSync(agentsDir)) {
    for (const ent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (ent.isDirectory() && !files.has(path.join(ent.name, 'SKILL.md'))) problems.push(`本体がない入口: ${ent.name}`);
    }
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const problems = checkAgentSkills();
    if (problems.length) {
      process.stdout.write('Codex 用の入口が最新ではありません:\n' + problems.map((p) => `  - ${p}`).join('\n') + '\n直すには: node scripts/sync-agent-skills.mjs\n');
      process.exitCode = 1;
    } else {
      process.stdout.write('Codex 用の入口は最新です。\n');
    }
  } else {
    for (const [rel, content] of buildAgentSkillFiles()) {
      const p = path.join(AGENTS_DIR, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      process.stdout.write(`書きました: .agents/skills/${rel.split(path.sep).join('/')}\n`);
    }
  }
}
