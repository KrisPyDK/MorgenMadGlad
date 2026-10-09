/**
 * Samler den fælles logik og serveren til én fil, apps-script/Code.gs, som
 * kan kopieres direkte ind i Google Apps Script (der ikke forstår moduler).
 *
 *   npm run build
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const SOURCES = ['js/schedule.js', 'js/requests.js', 'apps-script/server.js'];
export const OUTPUT = 'apps-script/Code.gs';

const HEADER = `/**
 * MorgenMadGlad – Google Apps Script
 *
 * GENERERET FIL – ret i js/ eller apps-script/server.js og kør "npm run build".
 * Kopiér hele filen ind i Apps Script-editoren. Se README.md for opsætning.
 */
`;

export function buildAppsScript() {
  const parts = SOURCES.map((file) => {
    const source = readFileSync(new URL(file, root), 'utf8')
      .replace(/^import\s[\s\S]*?\sfrom\s+['"][^'"]+['"];?[ \t]*\n/gm, '')
      .replace(/^export\s+/gm, '');
    return `// ===== ${file} =====\n\n${source.trim()}\n`;
  });
  return `${HEADER}\n${parts.join('\n')}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL(OUTPUT, root), buildAppsScript());
  console.log(`Skrev ${OUTPUT}`);
}
