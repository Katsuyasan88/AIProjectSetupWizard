---
name: project-update
description: ウィザード自体の更新提案を出す。Claude Code 公式ドキュメント (skills / commands / memory の3 URLだけ) と確認済みの導入版の比較と、ユーザーが指定した案件の管理文書からのベストプラクティスの取り込み。提案が基本で、テンプレートの変更は承認後のみ。install・CLI 更新・権限変更はしない。
---

# project-update (Codex 用の入口)

この Skill の手順の本体は `.claude/skills/project-update/SKILL.md` にあります。まずそのファイルを最後まで読み、そこに書かれた原則と手順にそのまま従ってください。
Claude Code と Codex で同じ手順を使うため、ここには複製を置いていません。このファイルは `node scripts/sync-agent-skills.mjs` が作るので、直接は編集しません。

## 読み替え

- 本文の `/project-update` は、Codex では `$project-update` と打つか、`/skills` から選ぶ操作にあたります。
- 本文の「質問ウィンドウ (AskUserQuestion)」が使えない環境では、同じ質問と選択肢を番号付きで会話に示し、番号か自由記述で答えてもらいます。1 回に聞くのは 4 問までで、選択肢の内容は変えません。回答は承認ではない、という扱いも同じです。
- 本文の「あなた」は、この Skill を実行している AI を指します。
- CLI は、このリポジトリの直下で `node scripts/cli.mjs ...` として実行します。
