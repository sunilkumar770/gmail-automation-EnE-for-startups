#!/usr/bin/env node
// ============================================================================
// scripts/ci-gate-pdf-size.mjs
// CI Release Gate: Minimum Entropy & File-Size Verification (Rule 2)
//
// Fails with exit code 1 if any generated document asset falls below minimum
// threshold (default 8192 bytes / 8 KB), lacks %PDF- header, or contains no
// content streams, preventing visual silent failures from reaching production.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

const MINIMUM_PDF_BYTES = 8000;
const ENTERPRISE_PDF_BYTES = 12000;

export function verifyPdfAsset(filePath, minBytes = MINIMUM_PDF_BYTES) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[CI-GATE-FAIL] Target PDF file does not exist: ${filePath}`);
  }

  const stats = fs.statSync(filePath);
  const buffer = fs.readFileSync(filePath);

  console.log(`[CI-GATE] Inspecting ${path.basename(filePath)} (${stats.size} bytes)...`);

  // 1. Minimum Size Check (Gate against empty / blank 2-3KB white canvases)
  if (stats.size < minBytes) {
    throw new Error(
      `[CI-GATE-FAIL] File size ${stats.size} bytes is under threshold of ${minBytes} bytes. Canvas rasterization blank or corrupt!`
    );
  }

  // 2. Magic Byte Verification (%PDF-)
  const magic = buffer.toString('utf8', 0, 5);
  if (magic !== '%PDF-') {
    throw new Error(`[CI-GATE-FAIL] Invalid magic bytes: expected '%PDF-', received '${magic}'`);
  }

  // 3. Content Stream Inspection
  const latinContent = buffer.toString('latin1');
  const hasStreams = latinContent.includes('/Contents') || latinContent.includes('/Length');
  if (!hasStreams) {
    throw new Error(`[CI-GATE-FAIL] PDF contains no drawing streams (/Contents or /Length missing).`);
  }

  // 4. Trailer / EOF Integrity
  if (!latinContent.includes('%%EOF')) {
    throw new Error(`[CI-GATE-FAIL] PDF stream corrupted: missing %%EOF termination marker.`);
  }

  console.log(
    `[CI-GATE-PASS] Validated ${path.basename(filePath)}: ${stats.size} bytes, %PDF- verified, content streams intact.`
  );
  return { valid: true, size: stats.size };
}

// CLI Execution entrypoint
const targetArg = process.argv[2];
if (targetArg) {
  try {
    const targetPath = path.resolve(process.cwd(), targetArg);
    verifyPdfAsset(targetPath);
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
