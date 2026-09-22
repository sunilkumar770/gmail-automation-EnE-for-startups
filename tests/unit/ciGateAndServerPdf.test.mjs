import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { verifyPdfAsset } from '../../scripts/ci-gate-pdf-size.mjs';

// Import transpiled GET route from tests/.build/route-pdf.mjs
const { GET } = await import('../.build/route-pdf.mjs');

test('Server-Side Deterministic PDF: generates compliant %PDF- stream > 12KB with proper headers', async () => {
  const req = new Request('http://localhost:3000/api/invoices/test-order-123/pdf');
  const response = await GET(req, { params: { id: 'test-order-123' } });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.match(response.headers.get('content-disposition'), /GoRentls_Invoice_test-order-123\.pdf/);

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Structural & Binary Assertions
  assert.ok(buffer.length > 12000, `Buffer size (${buffer.length} bytes) must be > 12000 bytes`);
  assert.equal(buffer.toString('utf8', 0, 5), '%PDF-');

  const latin1 = buffer.toString('latin1');
  assert.ok(latin1.includes('/Contents'), 'Must contain /Contents stream');
  assert.ok(latin1.includes('/Length'), 'Must contain /Length descriptor');
  assert.ok(latin1.includes('GoRentls Marketplace'), 'Must contain brand receipt header');
  assert.ok(latin1.includes('Sarah Connor'), 'Must contain customer name');
  assert.ok(latin1.includes('Total Paid'), 'Must contain summary');
  assert.ok(latin1.includes('%%EOF'), 'Must terminate with %%EOF');
});

test('Rule 2 CI Gate: passes on valid enterprise PDF (> 12 KB)', async () => {
  const req = new Request('http://localhost:3000/api/invoices/test-order-123/pdf');
  const response = await GET(req, { params: { id: 'test-order-123' } });
  const buffer = Buffer.from(await response.arrayBuffer());

  const tmpFile = path.resolve(process.cwd(), 'tests/.build/test-valid-invoice.pdf');
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, buffer);

  try {
    const result = verifyPdfAsset(tmpFile, 12000);
    assert.equal(result.valid, true);
    assert.ok(result.size > 12000);
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('Rule 2 CI Gate: rejects sub-threshold / blank PDF (< 8 KB) with error', async () => {
  const blankPdfContent = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF\n';
  const tmpFile = path.resolve(process.cwd(), 'tests/.build/test-corrupt-invoice.pdf');
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, blankPdfContent);

  try {
    assert.throws(
      () => {
        verifyPdfAsset(tmpFile, 8000);
      },
      (err) => {
        return (
          err.message.includes('[CI-GATE-FAIL]') &&
          err.message.includes('under threshold')
        );
      }
    );
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('Rule 2 CI Gate: rejects files with invalid magic bytes', async () => {
  const corruptedBinary = 'CORRUPTED_NOT_A_PDF_STREAM_HEADER_DATA_PADDING_'.repeat(200);
  const tmpFile = path.resolve(process.cwd(), 'tests/.build/test-invalid-magic.pdf');
  fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
  fs.writeFileSync(tmpFile, corruptedBinary);

  try {
    assert.throws(
      () => {
        verifyPdfAsset(tmpFile, 8000);
      },
      (err) => {
        return (
          err.message.includes('[CI-GATE-FAIL]') &&
          err.message.includes('Invalid magic bytes')
        );
      }
    );
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});
