/**
 * Unit tests for the chat ↔ session mapping.
 *
 * File-backed cases use a scratch path under `_dev/` (git-ignored) because
 * the development sandbox only permits writes inside the workspace.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionMap } from '../src/session-map.js';

const SCRATCH = join(process.cwd(), '_dev', 'test-session-map');
const FILE = join(SCRATCH, 'map.json');

let seq = 0;
const mint = (): string => `feishu-session-${++seq}`;

beforeEach(() => {
  seq = 0;
});

describe('SessionMap (in-memory)', () => {
  it('mints a session on ensure and returns the same id afterwards', () => {
    const map = new SessionMap(FILE, mint);
    expect(map.ensure('oc_group_1')).toBe('feishu-session-1');
    expect(map.ensure('oc_group_1')).toBe('feishu-session-1');
    expect(map.size).toBe(1);
  });

  it('resolves both directions of the mapping', () => {
    const map = new SessionMap(FILE, mint);
    map.ensure('oc_group_1');
    expect(map.get('oc_group_1')).toBe('feishu-session-1');
    expect(map.chatFor('feishu-session-1')).toBe('oc_group_1');
    expect(map.get('missing')).toBeUndefined();
    expect(map.chatFor('missing')).toBeUndefined();
  });

  it('keeps both directions consistent when a chat rebinds to a new session', () => {
    const map = new SessionMap(FILE, mint);
    map.set('oc_group_1', 'old-session');
    map.set('oc_group_1', 'new-session');
    expect(map.get('oc_group_1')).toBe('new-session');
    expect(map.chatFor('old-session')).toBeUndefined();
    expect(map.chatFor('new-session')).toBe('oc_group_1');
  });
});

describe('SessionMap (persistence)', () => {
  beforeEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
  });

  afterEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('round-trips mappings through the file', () => {
    const first = new SessionMap(FILE, mint);
    first.ensure('oc_group_1');
    first.ensure('oc_group_2');
    first.persist();

    const second = new SessionMap(FILE, mint);
    second.load();
    expect(second.get('oc_group_1')).toBe('feishu-session-1');
    expect(second.get('oc_group_2')).toBe('feishu-session-2');
    expect(second.chatFor('feishu-session-1')).toBe('oc_group_1');
  });

  it('load is a no-op for a missing file', () => {
    const map = new SessionMap(join(SCRATCH, 'absent.json'), mint);
    expect(() => map.load()).not.toThrow();
    expect(map.size).toBe(0);
  });

  it('starts empty when the file is malformed', () => {
    writeFileSync(FILE, 'not json', 'utf8');
    const map = new SessionMap(FILE, mint);
    map.load();
    expect(map.size).toBe(0);
  });
});
