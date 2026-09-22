export interface InvoiceData {
  invoiceId: string;
  customerName: string;
  items: Array<{ description: string; amount: number }>;
  totalAmount: number;
  date: string;
}

/**
 * Renders and downloads the invoice PDF securely with guaranteed visual rasterization.
 * 
 * Production-grade fixes & guarantees:
 * 1. Rule 3 Boundary Guards: Validates element presence, DOM connectivity (.isConnected),
 *    and non-empty content before any graphics pipeline or dynamic import is triggered.
 * 2. SSR Safe: Lazy-loads html2pdf.js dynamically to prevent UMD 'self is not defined'
 *    crashes during Next.js server pre-rendering or Node test environments.
 * 3. Viewport Origin Placement with opacity: 1: Mounts clone at (0, 0) behind the layer stack
 *    (z-index: -99999, pointer-events: none). Fixes the critical html2canvas globalAlpha bug
 *    where opacity: 0.01 paints a 99% transparent/blank canvas into the PDF.
 * 4. Awaits document.fonts.ready and double animation frame paint tick for font/layout rasterization.
 * 5. Minimum Payload Size Guard: Asserts blob size >= 8000 bytes, catching blank/corrupted PDFs.
 * 6. Single-Pass Download Trigger: Uses URL.createObjectURL(pdfBlob) and an anchor element,
 *    preventing worker state corruption or duplicate execution from worker.save().
 * 7. Guaranteed DOM Cleanup: Removes staging container in a finally block.
 */
export async function downloadInvoice(
  templateElement: HTMLElement,
  filename: string
): Promise<void> {
  // 1. Boundary Guards: Validate presence, connectivity, and non-empty content (Rule 3)
  if (!templateElement) {
    throw new Error('Invoice template element not found.');
  }

  if (!templateElement.isConnected) {
    throw new Error('Invoice template element must be connected to the DOM.');
  }

  const hasContent = Boolean(
    templateElement.childElementCount > 0 ||
    templateElement.textContent?.trim() ||
    templateElement.innerHTML?.trim()
  );
  if (!hasContent) {
    throw new Error('Invoice template element is empty.');
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('downloadInvoice can only be executed in a browser environment.');
  }

  // 2. Clone element and mount inside viewport origin (x=0, y=0) behind layer stack
  // IMPORTANT: opacity MUST be 1. html2canvas captures computed style opacity directly.
  // Setting opacity < 1 rasterizes transparent pixels onto canvas, producing blank PDFs.
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  container.setAttribute('data-pdf-staging-container', 'true');
  container.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 790px; /* Standard A4 pixel equivalent at 96 DPI */
    background: #ffffff;
    z-index: -99999;
    opacity: 1;
    pointer-events: none;
    overflow: hidden;
  `;

  const clone = templateElement.cloneNode(true) as HTMLElement;
  clone.style.display = 'block';
  clone.style.visibility = 'visible';
  container.appendChild(clone);
  document.body.appendChild(container);

  try {
    // 3. Ensure web fonts (e.g., Inter/Roboto) are fully loaded
    if ('fonts' in document && document.fonts?.ready) {
      await document.fonts.ready;
    }

    // 4. Force Blink/WebKit layout reflow & double paint tick frame
    await new Promise<void>((resolve) => {
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => setTimeout(resolve, 100));
      } else {
        setTimeout(resolve, 100);
      }
    });

    // 5. Dynamic import of html2pdf to prevent SSR bundle crashes
    const html2pdfModule = await import('html2pdf.js');
    const html2pdf = html2pdfModule.default || html2pdfModule;

    // 6. Configure html2pdf with explicit html2canvas canvas bounds
    const formattedFilename = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
    const options = {
      margin: 0,
      filename: formattedFilename,
      image: { type: 'jpeg' as const, quality: 0.98 },
      html2canvas: {
        scale: 2, // High-DPI rasterization
        useCORS: true,
        logging: false,
        scrollX: 0,
        scrollY: 0,
        windowWidth: 790,
        x: 0,
        y: 0,
      },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' as const },
    };

    // 7. Generate PDF stream
    const worker = html2pdf().set(options).from(clone);
    const pdfBlob: Blob = await worker.output('blob');

    // 8. Verification Guard: A blank A4 PDF is typically < 3 KB; valid rendered PDF > 15 KB
    if (!pdfBlob || pdfBlob.size < 8000) {
      const actualSize = pdfBlob ? pdfBlob.size : 0;
      throw new Error(
        `Generated PDF binary under minimum payload threshold (${actualSize} bytes). Output corrupt or blank.`
      );
    }

    // 9. Trigger download safely via Object URL (avoids worker state corruption / re-entry)
    const blobUrl = URL.createObjectURL(pdfBlob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.href = blobUrl;
    downloadAnchor.download = formattedFilename;
    downloadAnchor.style.display = 'none';
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    document.body.removeChild(downloadAnchor);

    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 1000);
  } finally {
    // Guaranteed DOM cleanup
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }
}
