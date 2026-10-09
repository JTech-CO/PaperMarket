import { Resvg } from '@resvg/resvg-js';
import type { ReplyView } from '../discord/render.js';
import { chartRenderOptions } from './fonts.js';

/** Payload-based visual QA, not a screenshot or a claim about live Discord client layout. */
export function discordPayloadPreview(view: ReplyView, theme: 'DARK' | 'LIGHT', mobile = false): Buffer {
  const width = mobile ? 390 : 850; const left = mobile ? 12 : 100; const cardWidth = mobile ? 366 : 650;
  const background = theme === 'DARK' ? '#313338' : '#F2F3F5'; const surface = theme === 'DARK' ? '#2B2D31' : '#FFFFFF';
  const color = theme === 'DARK' ? '#F2F3F5' : '#111827'; const secondary = theme === 'DARK' ? '#B5BAC1' : '#4B5563';
  const data = view.embeds[0]!.toJSON(); let y = 79;
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const plain = (value: string) => value.replace(/\\([*_~`>])/g, '$1').replace(/\*\*/g, '');
  const rows: string[] = [];
  const write = (value: string, size: number, bold = false, fill = color) => {
    for (const original of plain(value).split('\n')) {
      let line = ''; let pixels = 0;
      const flush = () => { rows.push(`<text x="${left + 18}" y="${y}" font-size="${size}"${bold ? ' font-weight="600"' : ''} fill="${fill}">${escape(line.trimEnd())}</text>`); y += size + 7; line = ''; pixels = 0; };
      const widthOf = (value: string) => [...value].reduce((sum, character) => sum + (character.charCodeAt(0) > 127 ? size : size * 0.56), 0);
      const available = cardWidth - 40;
      for (const token of original.match(/\S+|\s+/g) ?? []) {
        const tokenWidth = widthOf(token);
        if (tokenWidth <= available) {
          if (pixels + tokenWidth > available && line.trim()) flush();
          if (!line && !token.trim()) continue;
          line += token; pixels += tokenWidth;
        } else for (const character of token) {
          const charWidth = widthOf(character);
          if (pixels + charWidth > available) flush();
          line += character; pixels += charWidth;
        }
      }
      flush();
    }
  };
  write(data.title ?? '', 18, true); y += 7;
  write(data.description ?? '', 14);
  for (const field of data.fields ?? []) { y += 12; write(field.name, 14, true); write(field.value, 14); }
  y += 14; write(data.footer?.text ?? '', 12, false, secondary);
  const cardBottom = y + 12; y += 30; let x = left;
  for (const row of view.components) for (const component of row.toJSON().components) {
    if (!('label' in component) || typeof component.label !== 'string') continue;
    const buttonWidth = Math.min(cardWidth, Math.max(65, [...component.label].length * 13 + 24));
    if (x + buttonWidth > left + cardWidth) { x = left; y += 44; }
    const opacity = 'disabled' in component && component.disabled ? '0.45' : '1';
    rows.push(`<g opacity="${opacity}"><rect x="${x}" y="${y-20}" width="${buttonWidth}" height="34" rx="4" fill="${theme === 'DARK' ? '#4E5058' : '#E3E5E8'}"/><text x="${x+12}" y="${y+2}" font-size="13" fill="${color}">${escape(component.label)}</text></g>`); x += buttonWidth + 8;
  }
  const height = y + 65;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${background}"/><rect x="${left}" y="45" width="${cardWidth}" height="${cardBottom-45}" rx="4" fill="${surface}"/><rect x="${left}" y="45" width="4" height="${cardBottom-45}" fill="#${(data.color ?? 0x6B7280).toString(16).padStart(6,'0')}"/><g font-family="Malgun Gothic,Noto Sans KR,Arial,sans-serif"><text x="${left}" y="28" font-size="12" fill="${secondary}">Payload QA · ${theme} · ${mobile ? 'MOBILE' : 'DESKTOP'} · synthetic fixture</text>${rows.join('')}</g></svg>`;
  return Buffer.from(new Resvg(svg, chartRenderOptions).render().asPng());
}
