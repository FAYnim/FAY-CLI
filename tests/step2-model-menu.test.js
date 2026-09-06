/**
 * Step 2: Interactive TUI Model Picker (src/ui/model-menu.js)
 * Verifies:
 *  - buildModelMenuItems: ordering, active marker, empty input
 *  - showModelMenu: returns cancelled when not TTY / no items
 *  - showModelMenu: enter key selects current item
 *  - showModelMenu: down arrow moves selection, wraps at boundaries
 *  - showModelMenu: up arrow wraps from index 0
 *  - showModelMenu: escape cancels
 *  - showModelMenu: ctrl-c cancels
 *  - showModelMenu: provider sections rendered with active marker
 *  - showModelMenu: item with isActive=true is pre-selected
 *  - showModelMenuFromConfig: builds items from configMgr & active provider
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import {
  buildModelMenuItems,
  showModelMenu,
  showModelMenuFromConfig,
} from '../src/ui/model-menu.js';

// --- Mock TTY input stream with keypress support -----------------------

/**
 * A minimal stand-in for a TTY stdin that supports setRawMode and emits
 * 'keypress' events via readline.emitKeypressEvents.
 */
class MockTtyInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.readable = true;
    this._rawMode = false;
  }
  setRawMode(enabled) {
    this._rawMode = Boolean(enabled);
    return this._rawMode;
  }
  isRaw() {
    return this._rawMode;
  }
  resume() {}
  pause() {}
  // Simulate a keypress
  pressKey(keyObj) {
    this.emit('keypress', null, keyObj);
  }
}

// --- Helper to create a stable menu dataset -----------------------------

function makeItems() {
  return [
    { providerId: 'gemini', model: 'gemini-2.5-flash', isActive: true, isCurrentProvider: true },
    { providerId: 'gemini', model: 'gemini-2.5-pro', isActive: false, isCurrentProvider: true },
    { providerId: 'gemini', model: 'gemini-1.5-flash', isActive: false, isCurrentProvider: true },
    { providerId: 'openai', model: 'gpt-4o-mini', isActive: false, isCurrentProvider: false },
    { providerId: 'openai', model: 'gpt-4o', isActive: false, isCurrentProvider: false },
  ];
}

// --- Tests --------------------------------------------------------------

describe('Step 2: Interactive TUI Model Menu (src/ui/model-menu.js)', () => {
  test('buildModelMenuItems flattens provider+model pairs and marks active', () => {
    const items = buildModelMenuItems(
      { gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'], openai: ['gpt-4o-mini'] },
      'gemini',
      'gemini-2.5-flash',
    );
    assert.equal(items.length, 3);
    assert.equal(items[0].providerId, 'gemini');
    assert.equal(items[0].model, 'gemini-2.5-flash');
    assert.equal(items[0].isActive, true);
    assert.equal(items[0].isCurrentProvider, true);
    assert.equal(items[1].isActive, false);
    assert.equal(items[2].providerId, 'openai');
    assert.equal(items[2].isCurrentProvider, false);
  });

  test('buildModelMenuItems handles missing/empty input gracefully', () => {
    assert.deepEqual(buildModelMenuItems(undefined, 'gemini', 'gemini-2.5-flash'), []);
    assert.deepEqual(buildModelMenuItems({}, 'gemini', 'gemini-2.5-flash'), []);
    assert.deepEqual(
      buildModelMenuItems({ gemini: [], openai: [] }, 'gemini', 'gemini-2.5-flash'),
      [],
    );
  });

  test('buildModelMenuItems filters out non-string and empty models', () => {
    const items = buildModelMenuItems(
      { gemini: ['gemini-2.5-flash', '', null, undefined, 42, '  ', 'gemini-2.5-pro'] },
      'gemini',
      'gemini-2.5-flash',
    );
    assert.equal(items.length, 2);
    assert.equal(items[0].model, 'gemini-2.5-flash');
    assert.equal(items[1].model, 'gemini-2.5-pro');
  });

  test('showModelMenu returns cancelled when items array is empty', async () => {
    const input = new MockTtyInput();
    const output = new PassThrough();
    const res = await showModelMenu([], {
      input,
      output,
      activeProvider: 'gemini',
      activeModel: 'gemini-2.5-flash',
      enabled: true,
    });
    assert.deepEqual(res, { cancelled: true });
  });

  test('showModelMenu returns cancelled when not a TTY (enabled: false)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const res = await showModelMenu(makeItems(), {
      input,
      output,
      activeProvider: 'gemini',
      activeModel: 'gemini-2.5-flash',
      enabled: false,
    });
    assert.deepEqual(res, { cancelled: true });
  });

  test('showModelMenu: Enter key returns the pre-selected (active) model', async () => {
    const input = new MockTtyInput();
    const output = new PassThrough();

    const promise = showModelMenu(makeItems(), {
      input,
      output,
      activeProvider: 'gemini',
      activeModel: 'gemini-2.5-flash',
      enabled: true,
    });

    // Defer so the menu has a chance to register its listener
    setImmediate(() => {
      input.pressKey({ name: 'return' });
    });

    const res = await promise;
    assert.deepEqual(res, { cancelled: false, providerId: 'gemini', model: 'gemini-2.5-flash' });
  });

  test('showModelMenu: down arrow moves selection; Enter selects the new one', async () => {
    const input = new MockTtyInput();
    const output = new PassThrough();

    const promise = showModelMenu(makeItems(), {
      input,
      output,
      activeProvider: 'gemini',
      activeModel: 'gemini-2.5-flash',
      enabled: true,
    });

    setImmediate(() => {
      input.pressKey({ name: 'down' });
      input.pressKey({ name: 'down' });
      input.pressKey({ name: 'return' });
    });

    const res = await promise;
    // 0 -> 1 -> 2 → gemini-1.5-flash
    assert.deepEqual(res, { cancelled: false, providerId: 'gemini', model: 'gemini-1.5-flash' });
  });

  test('showModelMenu: up arrow wraps from index 0 to last item', async () => {
    const input = new MockTtyInput();
    const output = new PassThrough();

    const promise = showModelMenu(makeItems(), {
      input,
      output,
      activeProvider: 'gemini',
      activeModel: 'gemini-2.5-flash',
      enabled: true,
    });

    setImmediate(() => {
      input.pressKey({ name: 'up' });
      input.pressKey({ name: 'return' });
    });

    const res = await promise;
    // wrapping up from 0 → last (index 4) → gpt-4o
    assert.deepEqual(res, { cancelled: false, providerId: 'openai', model: 'gpt-4o' });
  });

  test('showModelMenu: down arrow wraps from last item to first', async () => {
    const input = new MockTtyInput();
    const output = new PassThrough();

    // Active = last item so it gets pre-selected
    const items = makeItems();
    items[items.length - 1].isActive = true;
    items[0].isActive = false;

    const promise = showModelMenu(items, {
      input,
      output,
      activeProvider: 'openai',
      activeModel: 'gpt-4o',
      enabled: true,
    });

    setImmediate(() => {
      input.pressKey({ name: 'down' });
      input.pressKey({ name: 'return' });
    });

    const res = await promise;
    // start at last index (4) → down → wraps to 0 → gemini-2.5-flash
    assert.deepEqual(res, { cancelled: false, providerId: 'gemini', model: 'gemini-2.5-flash' });
  });

  test('showModelMenu: escape key cancels the menu', async () => {
    const input = new MockTtyInput();
    const output = new PassThrough();

    const promise = showModelMenu(makeItems(), {
      input,
      output,
      activeProvider: 'gemini',
      activeModel: 'gemini-2.5-flash',
      enabled: true,
    });

    setImmediate(() => {
      input.pressKey({ name: 'escape' });
    });

    const res = await promise;
    assert.deepEqual(res, { cancelled: true });
  });

  test('showModelMenu: q key cancels the menu', async () => {
    const input = new MockTtyInput();
    const output = new PassThrough();

    const promise = showModelMenu(makeItems(), {
      input,
      output,
      activeProvider: 'gemini',
      activeModel: 'gemini-2.5-flash',
      enabled: true,
    });

    setImmediate(() => {
      input.pressKey({ name: 'q' });
    });

    const res = await promise;
    assert.deepEqual(res, { cancelled: true });
  });

  test('showModelMenu: calls input.resume() to keep event loop alive', async () => {
    let resumed = false;
    const input = new MockTtyInput();
    input.resume = () => {
      resumed = true;
    };
    const output = new PassThrough();

    const promise = showModelMenu(makeItems(), {
      input,
      output,
      activeProvider: 'gemini',
      activeModel: 'gemini-2.5-flash',
      enabled: true,
    });

    setImmediate(() => {
      input.pressKey({ name: 'escape' });
    });

    await promise;
    assert.equal(resumed, true);
  });

  test('showModelMenu: ctrl-c cancels the menu', async () => {
    const input = new MockTtyInput();
    const output = new PassThrough();

    const promise = showModelMenu(makeItems(), {
      input,
      output,
      activeProvider: 'gemini',
      activeModel: 'gemini-2.5-flash',
      enabled: true,
    });

    setImmediate(() => {
      input.pressKey({ ctrl: true, name: 'c' });
    });

    const res = await promise;
    assert.deepEqual(res, { cancelled: true });
  });

  test('showModelMenu: pre-selects the active model when found in items', async () => {
    const input = new MockTtyInput();
    const output = new PassThrough();

    // Active = gpt-4o (index 4)
    const items = makeItems();
    items[4].isActive = true;
    items[0].isActive = false;

    const promise = showModelMenu(items, {
      input,
      output,
      activeProvider: 'openai',
      activeModel: 'gpt-4o',
      enabled: true,
    });

    setImmediate(() => {
      input.pressKey({ name: 'return' });
    });

    const res = await promise;
    assert.deepEqual(res, { cancelled: false, providerId: 'openai', model: 'gpt-4o' });
  });

  test('showModelMenu: home and end keys jump to first/last item', async () => {
    const input = new MockTtyInput();
    const output = new PassThrough();

    const promise = showModelMenu(makeItems(), {
      input,
      output,
      activeProvider: 'gemini',
      activeModel: 'gemini-2.5-flash',
      enabled: true,
    });

    setImmediate(() => {
      input.pressKey({ name: 'end' });
      // From last item, jump to home → first item
      input.pressKey({ name: 'home' });
      input.pressKey({ name: 'return' });
    });

    const res = await promise;
    // end → index 4 (gpt-4o), home → index 0 (gemini-2.5-flash)
    assert.deepEqual(res, { cancelled: false, providerId: 'gemini', model: 'gemini-2.5-flash' });
  });

  test('showModelMenu: writes menu content to output (includes model names and active marker)', async () => {
    const input = new MockTtyInput();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => {
      written += chunk.toString('utf8');
    });

    const promise = showModelMenu(makeItems(), {
      input,
      output,
      activeProvider: 'gemini',
      activeModel: 'gemini-2.5-flash',
      enabled: true,
    });

    setImmediate(() => {
      input.pressKey({ name: 'escape' });
    });

    await promise;

    // Strip ANSI for assertions
    const plain = written.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    assert.ok(plain.includes('Select a model'), 'menu header should be rendered');
    assert.ok(plain.includes('gemini-2.5-flash'), 'gemini-2.5-flash should be listed');
    assert.ok(plain.includes('gemini-2.5-pro'), 'gemini-2.5-pro should be listed');
    assert.ok(plain.includes('gpt-4o-mini'), 'gpt-4o-mini should be listed');
    assert.ok(plain.includes('(active)'), 'active model should be marked');
    assert.ok(plain.includes('gemini'), 'gemini provider section should be present');
    assert.ok(plain.includes('openai'), 'openai provider section should be present');
    assert.ok(plain.includes('Current:'), 'footer with current model should be present');
  });

  test('showModelMenuFromConfig: returns cancelled when configMgr is missing', async () => {
    const res = await showModelMenuFromConfig({});
    assert.deepEqual(res, { cancelled: true });
  });

  test('showModelMenuFromConfig: builds items from configMgr providers and active model', async () => {
    // Use a real ConfigManager with a temp dir
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { ConfigManager } = await import('../src/config/manager.js');

    const tmpDir = path.join(
      os.tmpdir(),
      `tai-menu-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    const configMgr = new ConfigManager(tmpDir);
    // Configure openai so it shows up in the menu
    configMgr.setProviderField('openai', 'apiKey', 'test-openai-key');

    const input = new MockTtyInput();
    const output = new PassThrough();
    const mockOrch = {
      provider: 'gemini',
      llmClient: { getModel: () => 'gemini-2.5-flash' },
    };

    const promise = showModelMenuFromConfig({
      configMgr,
      orchestrator: mockOrch,
      input,
      output,
    });

    setImmediate(() => {
      input.pressKey({ name: 'escape' });
    });

    const res = await promise;
    // We only assert that it returned cleanly (escape was pressed)
    assert.deepEqual(res, { cancelled: true });

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test('showModelMenuFromConfig: non-TTY input returns cancelled without prompting', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { ConfigManager } = await import('../src/config/manager.js');

    const tmpDir = path.join(
      os.tmpdir(),
      `tai-menu-pipe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    const configMgr = new ConfigManager(tmpDir);
    configMgr.setProviderField('openai', 'apiKey', 'test-openai-key');

    const input = new PassThrough(); // not a TTY
    const output = new PassThrough(); // not a TTY
    const mockOrch = {
      provider: 'gemini',
      llmClient: { getModel: () => 'gemini-2.5-flash' },
    };

    const res = await showModelMenuFromConfig({
      configMgr,
      orchestrator: mockOrch,
      input,
      output,
    });

    assert.deepEqual(res, { cancelled: true });

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  });
});
