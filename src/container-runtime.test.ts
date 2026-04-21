import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Native mode: no-op functions ---

describe('ensureContainerRuntimeRunning', () => {
  it('is a no-op in native mode', () => {
    ensureContainerRuntimeRunning();
    expect(logger.debug).toHaveBeenCalledWith(
      'Native mode — no container runtime needed',
    );
  });
});

describe('cleanupOrphans', () => {
  it('is a no-op in native mode', () => {
    cleanupOrphans();
    expect(logger.debug).toHaveBeenCalledWith(
      'Native mode — no orphan cleanup needed',
    );
  });
});
