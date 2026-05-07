/**
 * Platform utilities for NanoClaw setup (Linux only).
 */
import { execSync } from 'child_process';
import fs from 'fs';

export type Platform = 'linux';
export type ServiceManager = 'systemd' | 'none';

export function getPlatform(): Platform {
  return 'linux';
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

export function isHeadless(): boolean {
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

export function hasSystemd(): boolean {
  try {
    const init = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
    return init === 'systemd';
  } catch {
    return false;
  }
}

export function openBrowser(url: string): boolean {
  try {
    if (commandExists('xdg-open')) {
      execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: 'ignore' });
      return true;
    }
  } catch {
    // Command failed
  }
  return false;
}

export function getServiceManager(): ServiceManager {
  if (hasSystemd()) return 'systemd';
  return 'none';
}

export function getNodePath(): string {
  try {
    return execSync('command -v node', { encoding: 'utf-8' }).trim();
  } catch {
    return process.execPath;
  }
}

export function commandExists(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function getNodeVersion(): string | null {
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    return version.replace(/^v/, '');
  } catch {
    return null;
  }
}

export function getNodeMajorVersion(): number | null {
  const version = getNodeVersion();
  if (!version) return null;
  const major = parseInt(version.split('.')[0], 10);
  return isNaN(major) ? null : major;
}
