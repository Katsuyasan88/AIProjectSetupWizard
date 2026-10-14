---
name: project-change
description: 既存案件を更新・導入する。ルール方針、4つの運用モード、各AIのモデルとeffort、直接更新か案件全体のコピーかを別々に選ぶ。差分・出力先・digestの承認後にCLIがバックアップ付きで反映する。ユーザーの明示操作のみ。
---

# project-change (Codex 用の入口)

この Skill の手順の本体は `.claude/skills/project-change/SKILL.md` にあります。まずそのファイルを最後まで読み、そこに書かれた原則と手順にそのまま従ってください。
Claude Code と Codex で同じ手順を使うため、ここには複製を置いていません。このファイルは `node scripts/sync-agent-skills.mjs` が作るので、直接は編集しません。

## 読み替え

- 本文の `/project-change` は、Codex では `$project-change` と打つか、`/skills` から選ぶ操作にあたります。
- 本文の「質問ウィンドウ (AskUserQuestion)」が使えない環境では、同じ質問と選択肢を番号付きで会話に示し、番号か自由記述で答えてもらいます。1 回に聞くのは 4 問までで、選択肢の内容は変えません。回答は承認ではない、という扱いも同じです。
- 本文の「あなた」は、この Skill を実行している AI を指します。
- CLI は、このリポジトリの直下で `node scripts/cli.mjs ...` として実行します。
- この Skill は書き込みを伴います。ユーザーが明示的に呼んだときだけ使い、自分の判断では使いません。
