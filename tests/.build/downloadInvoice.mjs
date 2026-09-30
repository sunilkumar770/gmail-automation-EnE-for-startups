// lib/downloadInvoice.ts
async function downloadInvoice(templateElement, filename) {
  if (!templateElement) {
    throw new Error("Invoice template element not found.");
  }
  if (!templateElement.isConnected) {
    throw new Error("Invoice template element must be connected to the DOM.");
  }
  const hasContent = Boolean(
    templateElement.childElementCount > 0 || templateElement.textContent?.trim() || templateElement.innerHTML?.trim()
  );
  if (!hasContent) {
    throw new Error("Invoice template element is empty.");
  }
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("downloadInvoice can only be executed in a browser environment.");
  }
  const container = document.createElement("div");
  container.setAttribute("aria-hidden", "true");
  container.setAttribute("data-pdf-staging-container", "true");
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
  const clone = templateElement.cloneNode(true);
  clone.style.display = "block";
  clone.style.visibility = "visible";
  container.appendChild(clone);
  document.body.appendChild(container);
  try {
    if ("fonts" in document && document.fonts?.ready) {
      await document.fonts.ready;
    }
    await new Promise((resolve) => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => setTimeout(resolve, 100));
      } else {
        setTimeout(resolve, 100);
      }
    });
    const html2pdfModule = await import("html2pdf.js");
    const html2pdf = html2pdfModule.default || html2pdfModule;
    const formattedFilename = filename.endsWith(".pdf") ? filename : `${filename}.pdf`;
    const options = {
      margin: 0,
      filename: formattedFilename,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: {
        scale: 2,
        // High-DPI rasterization
        useCORS: true,
        logging: false,
        scrollX: 0,
        scrollY: 0,
        windowWidth: 790,
        x: 0,
        y: 0
      },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
    };
    const worker = html2pdf().set(options).from(clone);
    const pdfBlob = await worker.output("blob");
    if (!pdfBlob || pdfBlob.size < 8e3) {
      const actualSize = pdfBlob ? pdfBlob.size : 0;
      throw new Error(
        `Generated PDF binary under minimum payload threshold (${actualSize} bytes). Output corrupt or blank.`
      );
    }
    const blobUrl = URL.createObjectURL(pdfBlob);
    const downloadAnchor = document.createElement("a");
    downloadAnchor.href = blobUrl;
    downloadAnchor.download = formattedFilename;
    downloadAnchor.style.display = "none";
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    document.body.removeChild(downloadAnchor);
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
    }, 1e3);
  } finally {
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }
}
export {
  downloadInvoice
};
