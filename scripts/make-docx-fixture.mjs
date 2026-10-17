/**
 * Generate tests/fixtures/minimal.docx — a minimal valid WordprocessingML
 * document with one Heading1 paragraph and one body paragraph.
 *
 * Run: node scripts/make-docx-fixture.mjs (jszip comes from the pnpm store
 * via mammoth's dependency tree; resolved with an explicit path so the
 * script has no hard runtime dep).
 */
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JSZip = require(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'node_modules',
    '.pnpm',
    'node_modules',
    'jszip',
  ),
);

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>On the Stability of Widget Networks</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Every widget network is stable under mild assumptions.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`;

const zip = new JSZip();
// Fixed dates so regeneration is byte-stable (JSZip defaults to now()).
const FIXED_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
const opts = { date: FIXED_DATE, createFolders: false };
zip.file('[Content_Types].xml', CONTENT_TYPES, opts);
zip.file('_rels/.rels', ROOT_RELS, opts);
zip.file('word/document.xml', DOCUMENT, opts);

const out = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'minimal.docx',
);
zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }).then((buf) => {
  createWriteStream(out).end(buf, () => console.log('wrote', out, buf.length, 'bytes'));
});
