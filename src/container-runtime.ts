/**
 * Container runtime abstraction for NanoClaw.
 * Native mode — no container runtime needed. Agents run as local processes.
 */
import { logger } from './logger.js';

/** Ensure the runtime is available. No-op in native mode. */
export function ensureContainerRuntimeRunning(): void {
  logger.debug('Native mode — no container runtime needed');
}

/** Kill orphaned processes. No-op in native mode (process lifecycle is managed by the OS). */
export function cleanupOrphans(): void {
  logger.debug('Native mode — no orphan cleanup needed');
}
