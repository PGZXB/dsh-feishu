/**
 * Unit tests for the surface command registry and slash parsing.
 */

import { describe, expect, it } from 'vitest';
import { CommandRegistry, parseSlash } from '../src/commands.js';

describe('parseSlash', () => {
  it('parses a command name and raw input', () => {
    expect(parseSlash('/help')).toEqual({ name: 'help', rawInput: '' });
    expect(parseSlash('/group  my team ')).toEqual({ name: 'group', rawInput: '  my team ' });
  });

  it('lowercases the name and keeps the input verbatim', () => {
    expect(parseSlash('/CANCEL now')).toEqual({ name: 'cancel', rawInput: ' now' });
  });

  it('is undefined for non-slash lines and bare slashes', () => {
    expect(parseSlash('hello')).toBeUndefined();
    expect(parseSlash('/')).toBeUndefined();
    expect(parseSlash('/  spaced')).toBeUndefined();
  });
});

describe('CommandRegistry', () => {
  it('registers and lists commands in order', () => {
    const registry = new CommandRegistry();
    registry.register({
      name: 'help',
      description: 'list',
      category: 'system',
      handler: () => ({ kind: 'success', text: 'ok' }),
    });
    registry.register({
      name: 'group',
      description: 'create',
      category: 'chat',
      handler: () => ({ kind: 'success', text: 'ok' }),
    });
    expect(registry.list().map((command) => command.name)).toEqual(['help', 'group']);
    expect(registry.find('group')?.description).toBe('create');
    expect(registry.find('missing')).toBeUndefined();
  });

  it('replaces a duplicate name without reordering', () => {
    const registry = new CommandRegistry();
    registry.register({
      name: 'help',
      description: 'first',
      category: 'system',
      handler: () => ({ kind: 'success', text: 'ok' }),
    });
    registry.register({
      name: 'help',
      description: 'second',
      category: 'system',
      handler: () => ({ kind: 'success', text: 'ok' }),
    });
    expect(registry.list()).toHaveLength(1);
    expect(registry.find('help')?.description).toBe('second');
  });
});
