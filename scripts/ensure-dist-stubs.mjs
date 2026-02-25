import fs from 'fs';
import path from 'path';

const ROOT = 'shared/core';

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '__tests__'].includes(e.name)) continue;
      walk(full);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) {
      const rel = path.relative(path.join(ROOT, 'src'), full);
      const dts = path.join(ROOT, 'dist', rel.replace(/\.ts$/, '.d.ts'));
      const js = path.join(ROOT, 'dist', rel.replace(/\.ts$/, '.js'));
      fs.mkdirSync(path.dirname(dts), { recursive: true });
      for (const f of [dts, js]) {
        if (!fs.existsSync(f) || fs.statSync(f).size < 3) {
          fs.writeFileSync(f, '// stub\n');
        }
      }
    }
  }
}

walk(path.join(ROOT, 'src'));
console.log('Dist stubs ensured');
