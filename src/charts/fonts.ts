import { existsSync } from 'node:fs';
import type { ResvgRenderOptions } from '@resvg/resvg-js';

// Fixed system paths only; no request input, directory traversal, downloads or font redistribution.
const candidates = [
  'C:/Windows/Fonts/malgun.ttf', 'C:/Windows/Fonts/malgunbd.ttf', 'C:/Windows/Fonts/arial.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/AppleSDGothicNeo.ttc',
];
const fontFiles = candidates.filter((path) => existsSync(path));
const hasKoreanFont = fontFiles.some((path) => /malgun|NotoSansCJK|AppleSDGothicNeo/.test(path));
const defaultFontFamily = fontFiles.some((path) => path.endsWith('/malgun.ttf')) ? 'Malgun Gothic'
  : fontFiles.some((path) => path.includes('NotoSansCJK')) ? 'Noto Sans CJK KR' : 'Apple SD Gothic Neo';

/** Avoid a full system-font scan for each PNG when known local fonts are available. */
export const chartRenderOptions: ResvgRenderOptions = {
  font: { loadSystemFonts: !hasKoreanFont, fontFiles, defaultFontFamily },
};
