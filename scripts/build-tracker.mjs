// Đóng gói script theo dõi, kiểm tra ngân sách kích thước, rồi xuất thành chuỗi để Worker phục vụ tại /t.js.
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const BUDGET_GZIP_BYTES = 3072;

const result = await build({
  entryPoints: ['src/tracker/index.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2018', 'safari13'],
  write: false,
  legalComments: 'none',
});

const code = result.outputFiles[0].text.trim();
const raw = Buffer.byteLength(code);
const gz = gzipSync(code, { level: 9 }).length;

mkdirSync('src/worker/generated', { recursive: true });
writeFileSync(
  'src/worker/generated/tracker.ts',
  `// Tự sinh bởi scripts/build-tracker.mjs — không sửa tay.\nexport const TRACKER_JS = ${JSON.stringify(code)};\nexport const TRACKER_GZIP_BYTES = ${gz};\n`,
);

console.log(`tracker: ${raw} B, gzip ${gz} B (ngân sách ${BUDGET_GZIP_BYTES} B)`);
if (gz > BUDGET_GZIP_BYTES) {
  console.error('Script theo dõi vượt ngân sách kích thước.');
  process.exit(1);
}
