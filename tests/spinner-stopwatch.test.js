/**
 * Unit Tests: Live Stopwatch & Duration Indicator in Spinner and Status Line
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, test } from 'node:test';
import { renderStatusLine } from '../src/ui/box.js';
import { createSpinner, Spinner } from '../src/ui/spinner.js';
import { setColorEnabled, stripAnsi } from '../src/utils/ansi.js';

describe('Spinner Stopwatch & Duration Feature', () => {
  beforeEach(() => {
    setColorEnabled(true);
  });

  test('should display elapsed time in live render output', () => {
    const mockStream = new PassThrough();
    let written = '';
    mockStream.on('data', (chunk) => {
      written += chunk.toString('utf8');
    });

    const spinner = new Spinner({
      text: 'Generating response...',
      stream: mockStream,
      enabled: true,
      showTimer: true,
    });

    spinner.start();
    // Advance simulated start time by 2.5 seconds
    spinner.startTime = Date.now() - 2500;
    spinner.render();
    spinner.stop();

    const plain = stripAnsi(written);
    assert.ok(plain.includes('Generating response...'));
    assert.ok(plain.includes('(2.5s)'));
  });

  test('should format duration in minutes and seconds when >= 60s', () => {
    const mockStream = new PassThrough();
    const spinner = new Spinner({
      text: 'Thinking...',
      stream: mockStream,
      enabled: true,
    });

    assert.equal(spinner.formatDuration(0), '0.0s');
    assert.equal(spinner.formatDuration(5200), '5.2s');
    assert.equal(spinner.formatDuration(65000), '1m 5s');
    assert.equal(spinner.formatDuration(125000), '2m 5s');
  });

  test('should omit elapsed timer when showTimer is false', () => {
    const mockStream = new PassThrough();
    let written = '';
    mockStream.on('data', (chunk) => {
      written += chunk.toString('utf8');
    });

    const spinner = new Spinner({
      text: 'Thinking without timer...',
      stream: mockStream,
      enabled: true,
      showTimer: false,
    });

    spinner.start();
    spinner.startTime = Date.now() - 3000;
    spinner.render();
    spinner.stop();

    const plain = stripAnsi(written);
    assert.ok(plain.includes('Thinking without timer...'));
    assert.ok(!plain.includes('(3.0s)'));
  });

  test('should reset stage timer on new start(text) but keep total elapsed', () => {
    const mockStream = new PassThrough();
    const spinner = new Spinner({
      stream: mockStream,
      enabled: true,
    });

    spinner.start('Phase 1');
    const totalStart = Date.now() - 10000;
    spinner.totalStartTime = totalStart;
    spinner.startTime = Date.now() - 5000;

    // Call start with new text -> stage timer resets
    spinner.start('Phase 2');
    assert.equal(spinner.text, 'Phase 2');
    assert.equal(spinner.totalStartTime, totalStart);
    assert.ok(Date.now() - spinner.startTime < 100);
    spinner.stop();
  });

  test('renderStatusLine includes duration when durationMs is provided', () => {
    const line = renderStatusLine({
      iterations: 2,
      maxIterations: 10,
      durationMs: 4200,
    });
    const plain = stripAnsi(line);
    assert.ok(plain.includes('4.2s'), `Expected '4.2s' in status line: ${plain}`);
  });
});
