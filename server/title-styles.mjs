import presets from './title-style-presets.json' with { type: 'json' };
export const TITLE_STYLE_PRESETS = presets;

// Styles are finite tokens, never CSS, URLs, HTML or downloadable fonts.
export function titleStyle(value, strict = false) {
  if (value === undefined) return { ...presets.defaults };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (strict) throw new Error('头衔样式须为对象');
    return { ...presets.defaults };
  }
  if (strict && Object.keys(value).some(k => !Object.hasOwn(presets.defaults, k))) throw new Error('头衔样式包含未知字段');
  const out = { ...presets.defaults };
  for (const [key, choices] of Object.entries({background:presets.backgrounds, fill:presets.fills, font:presets.fonts, weight:presets.weights})) {
    if (value[key] === undefined) continue;
    if (typeof value[key] === 'string' && Object.hasOwn(choices,value[key])) out[key] = value[key];
    else if (strict) throw new Error(`头衔 ${key} 须为 ${Object.keys(choices).join(' / ')}`);
  }
  if (typeof value.italic === 'boolean') out.italic = value.italic;
  else if (strict && value.italic !== undefined) throw new Error('italic 须为 true 或 false');
  return out;
}
