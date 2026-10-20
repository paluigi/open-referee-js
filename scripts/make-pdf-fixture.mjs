/**
 * Generate tests/fixtures/minimal.pdf — a hand-crafted single-page PDF with
 * known text lines: a title, the numbered heading "3. Main result", and body
 * text. Text is positioned with distinct baselines so pdf.js text items come
 * out line-by-line (see src/ingestion/pdf.ts for the joining heuristic).
 *
 * Run: node scripts/make-pdf-fixture.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Each entry: [x, baseline-y from top (PDF y is bottom-up), font size, text]
const LINES = [
  [72, 750, 14, 'On the Stability of Widget Networks'],
  [72, 700, 12, '3. Main result'],
  [72, 660, 11, 'We now state the theorem. Every widget is stable.'],
  [72, 620, 11, 'See Table 1 for the outcomes of the simulation.'],
];

function escapePdfText(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

let content = 'BT\n';
for (const [x, y, size, text] of LINES) {
  content += `/F1 ${size} Tf\n1 0 0 1 ${x} ${y} Tm\n(${escapePdfText(text)}) Tj\n`;
}
content += 'ET\n';

const objects = [];

// 1: Catalog
objects.push('<< /Type /Catalog /Pages 2 0 R >>');
// 2: Pages
objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
// 3: Page (Letter: 612x792)
objects.push(
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
);
// 4: Font
objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
// 5: Contents stream (with /Length — pdf.js requires it)
objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);

let pdf = '%PDF-1.4\n';
const offsets = [];
let pos = pdf.length;
for (let i = 0; i < objects.length; i++) {
  const num = i + 1;
  const obj = `${num} 0 obj\n${objects[i]}\nendobj\n`;
  offsets[num] = pos;
  pdf += obj;
  pos += obj.length;
}
const xrefPos = pos;
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += '0000000000 65535 f \n';
for (let i = 1; i <= objects.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

const out = path.join(here, '..', 'tests', 'fixtures', 'minimal.pdf');
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, pdf, 'latin1');
console.log('wrote', out, pdf.length, 'bytes');
