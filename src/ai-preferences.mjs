// AI の選択はデータ。起動コマンドを案内するだけで実行しない。
export const AI_EFFORTS = Object.freeze({
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
});

const MAX_FALLBACK_MODELS = 5;
const isModelId = (id) => /^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]*$/.test(id) && id.length <= 200;

export function normalizeAiPreferences(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ai: オブジェクトで指定してください');
  if (Object.keys(raw).some(key => !['codex', 'claude'].includes(key))) throw new Error('ai: 不明なAIのキーです');
  const result = {};
  for (const agent of ['codex', 'claude']) {
    const value = raw[agent] ?? {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`ai.${agent}: オブジェクトで指定してください`);
    if (Object.keys(value).some(key => !['model', 'effort', 'fallbackModels'].includes(key))) throw new Error(`ai.${agent}: 不明なキーです`);
    const preference = { model: '', effort: '', fallbackModels: [] };
    for (const key of ['model', 'effort']) {
      if (value[key] === undefined || value[key] === null || value[key] === '') continue;
      if (typeof value[key] !== 'string') throw new Error(`ai.${agent}.${key}: 文字列で指定してください`);
      preference[key] = value[key].trim();
    }
    if (preference.model && !isModelId(preference.model)) {
      throw new Error(`ai.${agent}.model: モデルIDまたは別名で指定してください (値は非表示)`);
    }
    // 指定のモデルが使えないときの代わり (順番つき)。モデルIDと同じ規則で検証する。
    const fallback = value.fallbackModels ?? [];
    if (!Array.isArray(fallback) || fallback.length > MAX_FALLBACK_MODELS || fallback.some(id => typeof id !== 'string' || !isModelId(id.trim()))) {
      throw new Error(`ai.${agent}.fallbackModels: モデルIDまたは別名の配列 (${MAX_FALLBACK_MODELS} 個まで) で指定してください (値は非表示)`);
    }
    preference.fallbackModels = [...new Set(fallback.map(id => id.trim()))].filter(id => id !== preference.model);
    if (preference.effort && !AI_EFFORTS[agent].includes(preference.effort)) throw new Error(`ai.${agent}.effort: このAIの対応候補から選んでください`);
    if (agent === 'codex' && ['gpt-6.1-sol', 'gpt-6-astra'].includes(preference.model) && ['none', 'minimal'].includes(preference.effort)) throw new Error(`ai.codex.effort: 選んだモデルで対応しない effort です`);
    result[agent] = preference;
  }
  return result;
}

export function aiLaunchCommand(agent, raw) {
  const key = agent.toLowerCase();
  const value = normalizeAiPreferences(raw)[key];
  let command = key;
  if (value.model) command += ` --model "${value.model}"`;
  if (value.effort) {
    command += key === 'codex' ? ` -c 'model_reasoning_effort="${value.effort}"'` : ` --effort ${value.effort}`;
  }
  return command;
}

export function renderAiPreferences(raw, agents = ['Codex', 'Claude']) {
  const ai = normalizeAiPreferences(raw);
  return `## モデルと reasoning effort\n\n<!-- psw:ai-preferences -->\n\n${agents.map(agent => {
    const value = ai[agent.toLowerCase()];
    return `- ${agent}: モデル ${value.model || '(既定)'} / effort ${value.effort || '(既定)'}${value.fallbackModels.length ? ` / 代わり: ${value.fallbackModels.join(' → ')}` : ''}`;
  }).join('\n')}\n\nこれは希望する起動設定です。文書の指示だけでは実行中のモデルは変わりません。起動時の選択をユーザーが確認し、対応しないモデル・effortなら使える組み合わせを選び直してください。モデルID・effortの利用可否はこのツールでは実行して確認していません。\n\n指定のモデルが使えないとき (混雑・非対応) は、「代わり」に書かれた順に使い、実際に使ったモデルを記録 (レビューの記録、なければ検証の結果記録) に書きます。代わりが書かれていなければ、別のモデルへ切り替える前にユーザーに確かめます。\n\nユーザーが対象フォルダで手動起動するときの例 (このツールは実行しない):\n\n\`\`\`text\n${agents.map(agent => aiLaunchCommand(agent, ai)).join('\n')}\n\`\`\`\n`;
}
