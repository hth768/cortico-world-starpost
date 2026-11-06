import presets from '../server/title-style-presets.json';

// Shared by the website bundle and Cortico console. Only preset values become CSS.
export function applyTitleStyle(node: HTMLElement, value?: unknown): void {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const choose = <T extends object>(key: string, options: T, fallback: keyof T): keyof T =>
    typeof raw[key] === 'string' && Object.hasOwn(options, raw[key]) ? raw[key] as keyof T : fallback;
  const background = choose('background',presets.backgrounds,'gold'), fill = choose('fill',presets.fills,'gradient');
  const font = choose('font',presets.fonts,'sans'), weight = choose('weight',presets.weights,'heavy');
  node.dataset.titleBackground = background; node.dataset.titleFill = fill; node.dataset.titleFont = font;
  for (const mode of ['light','dark'] as const) {
    const [a,b,ink,border] = presets.backgrounds[background][mode];
    node.style.setProperty(`--award-${mode}-bg`,fill==='gradient'?`linear-gradient(120deg,${a},${b})`:fill==='solid'?b:a);
    node.style.setProperty(`--award-${mode}-ink`,ink);node.style.setProperty(`--award-${mode}-border`,border);
  }
  node.style.fontFamily = presets.fonts[font].css;
  node.style.fontWeight = String(presets.weights[weight].value);
  node.style.fontStyle = raw.italic === true ? 'italic' : 'normal';
}

export const titleStyleCss = `
.account-title,.sp-account-title{background:var(--award-light-bg,linear-gradient(120deg,#fff1b8,#ffd980));color:var(--award-light-ink,#583600);border-color:var(--award-light-border,#9b6516)}
[data-theme=dark] .account-title,[data-theme=dark] .sp-account-title{background:var(--award-dark-bg,linear-gradient(120deg,#563808,#37260d));color:var(--award-dark-ink,#ffe09a);border-color:var(--award-dark-border,#e2b961)}
.account-title[data-title-fill=outline],.sp-account-title[data-title-fill=outline]{border-width:2px;box-shadow:none;border-radius:999px}
`;

export function installTitleStyles(): void {
  if(document.getElementById('starpost-title-styles'))return;
  const sheet=document.createElement('style');sheet.id='starpost-title-styles';sheet.textContent=titleStyleCss;document.head.append(sheet);
}
