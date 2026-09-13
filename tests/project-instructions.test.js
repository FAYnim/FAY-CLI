/**
 * Unit & Integration Tests: Auto-load Project Instructions (AGENTS.md)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config/constants.js';

describe('Project Instructions: Configuration', () => {
  test('DEFAULT_CONFIG contains instructionsFile set to AGENTS.md', () => {
    assert.equal(DEFAULT_CONFIG.instructionsFile, 'AGENTS.md');
  });
});
