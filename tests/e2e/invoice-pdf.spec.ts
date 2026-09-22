import { test, expect } from '@playwright/test';
import fs from 'fs';

test.describe('Invoice PDF Visual & Payload Integrity', () => {
  test('should generate a non-blank, valid PDF file when clicking Download Invoice', async ({ page }) => {
    // 1. Navigate to checkout/confirmation page
    await page.goto('/checkout/confirmation?orderId=test-order-123');
    await page.waitForSelector('[data-testid="download-invoice-btn"]');

    // 2. Listen for browser download event
    const downloadPromise = page.waitForEvent('download');
    await page.click('[data-testid="download-invoice-btn"]');
    const download = await downloadPromise;

    // 3. Save download file locally
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();

    const fileStats = fs.statSync(downloadPath!);
    const fileBuffer = fs.readFileSync(downloadPath!);

    // 4. Structural Assertions
    // A. Minimum Size Check: Rendered invoice with text/styles MUST be > 12 KB
    expect(fileStats.size).toBeGreaterThan(12000);

    // B. Magic Byte Verification: Confirm valid PDF binary header (%PDF-)
    const pdfHeader = fileBuffer.toString('utf8', 0, 5);
    expect(pdfHeader).toBe('%PDF-');

    // C. Non-Empty Stream Inspection: Verify PDF contains content streams (/Contents or /Length)
    const pdfContent = fileBuffer.toString('latin1');
    const hasContentStreams = pdfContent.includes('/Contents') || pdfContent.includes('/Length');
    expect(hasContentStreams).toBe(true);
  });

  test('should generate deterministic server-side PDF via GET /api/invoices/:id/pdf', async ({ request }) => {
    // Server-Side Deterministic PDF endpoint verification (Rule 4)
    const response = await request.get('/api/invoices/test-order-123/pdf');
    expect(response.status()).toBe(200);

    const headers = response.headers();
    expect(headers['content-type']).toContain('application/pdf');
    expect(headers['content-disposition']).toContain('attachment');
    expect(headers['content-disposition']).toContain('GoRentls_Invoice_test-order-123.pdf');

    const pdfBuffer = await response.body();

    // Structural Assertions:
    // A. Minimum Size Check (> 12 KB)
    expect(pdfBuffer.byteLength).toBeGreaterThan(12000);

    // B. Magic Byte Header
    const pdfHeader = pdfBuffer.toString('utf8', 0, 5);
    expect(pdfHeader).toBe('%PDF-');

    // C. Content Streams and Trailer Inspection
    const pdfContent = pdfBuffer.toString('latin1');
    expect(pdfContent).toContain('/Contents');
    expect(pdfContent).toContain('/Length');
    expect(pdfContent).toContain('%%EOF');
  });
});
