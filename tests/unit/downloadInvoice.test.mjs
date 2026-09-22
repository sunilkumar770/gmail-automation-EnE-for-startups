import test from 'node:test';
import assert from 'node:assert/strict';

// Set up minimal realistic DOM environment in Node for contract boundary testing (Rule 3)
class MockDOMElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.style = {};
    this.children = [];
    this.attributes = {};
    this.parentNode = null;
    this.isConnected = false;
    this.innerHTML = '';
    this.textContent = '';
  }

  get childElementCount() {
    return this.children.length;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  appendChild(child) {
    child.parentNode = this;
    child.isConnected = this.isConnected;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentNode = null;
      child.isConnected = false;
    }
    return child;
  }

  cloneNode(deep = true) {
    const clone = new MockDOMElement(this.tagName.toLowerCase());
    clone.style = { ...this.style };
    clone.innerHTML = this.innerHTML;
    clone.textContent = this.textContent;
    clone.isConnected = false;
    clone.parentNode = null;
    if (deep) {
      clone.children = this.children.map((c) => c.cloneNode(true));
    }
    return clone;
  }

  click() {
    this.clicked = true;
  }
}

class MockDocument {
  constructor() {
    this.body = new MockDOMElement('body');
    this.body.isConnected = true;
    this.fonts = { ready: Promise.resolve() };
  }

  createElement(tagName) {
    return new MockDOMElement(tagName);
  }

  contains(node) {
    let curr = node;
    while (curr) {
      if (curr === this.body) return true;
      curr = curr.parentNode;
    }
    return false;
  }
}

// Install mock DOM on globalThis
globalThis.document = new MockDocument();
globalThis.window = {
  requestAnimationFrame: (cb) => setTimeout(cb, 1),
};
globalThis.URL = globalThis.URL || {};
globalThis.URL.createObjectURL = (blob) => 'blob:mock-url-' + Math.random();
globalThis.URL.revokeObjectURL = () => {};

// Dynamic import of downloadInvoice
const { downloadInvoice } = await import('../../lib/downloadInvoice.ts');

test('Rule 3 Guard: throws when templateElement is null or undefined', async () => {
  await assert.rejects(
    async () => {
      await downloadInvoice(null, 'test.pdf');
    },
    {
      name: 'Error',
      message: 'Invoice template element not found.',
    }
  );

  await assert.rejects(
    async () => {
      await downloadInvoice(undefined, 'test.pdf');
    },
    {
      name: 'Error',
      message: 'Invoice template element not found.',
    }
  );
});

test('Rule 3 Guard: throws when target container is detached from DOM', async () => {
  // A newly created element without appending to document.body has isConnected = false
  const detachedNode = document.createElement('div');
  detachedNode.textContent = 'Detached Invoice Content';
  assert.equal(detachedNode.isConnected, false);

  await assert.rejects(
    async () => {
      await downloadInvoice(detachedNode, 'test.pdf');
    },
    {
      name: 'Error',
      message: 'Invoice template element must be connected to the DOM.',
    }
  );
});

test('Rule 3 Guard: throws when target container is attached but completely empty', async () => {
  const emptyNode = document.createElement('div');
  document.body.appendChild(emptyNode);
  assert.equal(emptyNode.isConnected, true);

  await assert.rejects(
    async () => {
      await downloadInvoice(emptyNode, 'test.pdf');
    },
    {
      name: 'Error',
      message: 'Invoice template element is empty.',
    }
  );

  // Clean up test element
  document.body.removeChild(emptyNode);
});

test('DOM Leak Guard: ensures staging container is removed even if rasterization fails', async () => {
  const attachedNode = document.createElement('div');
  attachedNode.textContent = 'Valid text but html2pdf will fail';
  document.body.appendChild(attachedNode);

  const initialBodyChildrenCount = document.body.children.length;

  try {
    await downloadInvoice(attachedNode, 'test.pdf');
  } catch (err) {
    // Expected to fail rasterization or threshold in mock environment
  }

  // Verify that the fixed staging container was cleanly removed in finally block
  const stagingContainerExists = document.body.children.some(
    (c) => c.getAttribute && c.getAttribute('data-pdf-staging-container') === 'true'
  );
  assert.equal(stagingContainerExists, false, 'Staging container must be removed in finally');

  document.body.removeChild(attachedNode);
});
