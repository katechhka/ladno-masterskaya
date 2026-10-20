import { mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from '../server/services/catalog.mjs';

const output = resolve(projectRoot, 'src/assets/fonts');
mkdirSync(output, { recursive: true });
for (const [family, styles] of [['unbounded', ['normal']], ['onest', ['normal']]]) {
  const source = resolve(projectRoot, 'node_modules/@fontsource-variable', family);
  for (const subset of ['cyrillic', 'latin']) {
    for (const style of styles) {
      const file = `${family}-${subset}-wght-${style}.woff2`;
      copyFileSync(resolve(source, 'files', file), resolve(output, file));
    }
  }
  copyFileSync(resolve(source, 'LICENSE'), resolve(output, `${family}-LICENSE.txt`));
}
console.log('Локальные шрифты и OFL-лицензии подготовлены.');
