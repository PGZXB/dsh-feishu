/**
 * Unit tests for the surface command set: registration through the host
 * seam and the shared harness passthrough.
 */

import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  planModeResultText,
  registerSurfaceCommands,
  runHarnessCommand,
  type SurfaceCommandHost,
} from '../src/commands/surface.js';
import { CommandRegistry, type CommandResult } from '../src/commands.js';
import type { CardAction, CardJson, FeishuTransport } from '../src/feishu/types.js';
import { SessionMap } from '../src/session-map.js';

/** A minimal transport fake (only what the commands touch). */
class FakeTransport implements FeishuTransport {
  readonly createdGroups: Array<{ name: string; memberOpenIds: readonly string[] }> = [];
  readonly sentFiles: Array<{ chatId: string; fileName: string; content: Uint8Array }> = [];
  readonly sentCards: Array<{ chatId: string; card: CardJson }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(_handler: (message: never) => void): void {}
  onCardAction(_handler: (action: CardAction) => void): void {}
  getBotOpenId(): string | undefined {
    return undefined;
  }
  async chatStats(_chatId: string): Promise<undefined> {
    return undefined;
  }
  async createGroup(name: string, memberOpenIds: readonly string[]): Promise<{ chatId: string }> {
    this.createdGroups.push({ name, memberOpenIds });
    return { chatId: `oc_group_${name}` };
  }
  async sendText(_chatId: string, _text: string): Promise<void> {}
  async sendFile(chatId: string, fileName: string, content: Uint8Array): Promise<void> {
    this.sentFiles.push({ chatId, fileName, content });
  }
  async sendImage(_chatId: string, _fileName: string, _bytes: Uint8Array): Promise<void> {}
  async addReaction(_messageId: string, _emojiType: string): Promise<string | undefined> {
    return undefined;
  }
  async removeReaction(_messageId: string, _reactionId: string): Promise<void> {}
  async sendCard(chatId: string, card: CardJson): Promise<{ messageId: string }> {
    this.sentCards.push({ chatId, card });
    return { messageId: `msg-${this.sentCards.length}` };
  }
  async updateCard(_messageId: string, _card: CardJson): Promise<void> {}
  async deleteMessage(_messageId: string): Promise<void> {}
  async downloadImage(
    _messageId: string,
    _key: string,
  ): Promise<{ data: Uint8Array; mediaType: string }> {
    throw new Error('downloadImage not implemented in this fake');
  }
  async downloadFile(
    _messageId: string,
    _key: string,
  ): Promise<{ stream: NodeJS.ReadableStream; head: Uint8Array }> {
    throw new Error('downloadFile not implemented in this fake');
  }
}
/** A fake agent (cast — only session id is used by the commands). */
function makeAgent(): Agent {
  return {
    session: { id: 'feishu-session-1' },
    followup: () => {},
    cancel: () => {},
  } as unknown as Agent;
}

/** Build a host + registry with the surface commands registered. */
function makeCommands(overrides: Partial<SurfaceCommandHost> = {}): {
  transport: FakeTransport;
  commands: CommandRegistry;
  host: SurfaceCommandHost;
} {
  const transport = new FakeTransport();
  const sessionMap = new SessionMap(join(process.cwd(), '_dev', 'test-cmd-map.json'));
  sessionMap.set('oc_chat', 'feishu-session-1');
  const agent = makeAgent();
  const base: SurfaceCommandHost = {
    transport,
    sessionMap,
    agentStore: {
      get: (sessionId) => (sessionId === 'feishu-session-1' ? agent : undefined),
      resume: async () => agent,
      create: async () => agent,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    executeCommand: undefined,
    readSession: undefined,
    permissionPresets: undefined,
    planMode: undefined,
    agentDefaultModel: undefined,
    llm: undefined,
    listSessions: undefined,
    groupMentionMode: undefined,
    appId: undefined,
    transportMode: undefined,
    unknownCommand: undefined,
    lastInboundAt: undefined,
    openPanel: async () => 'msg-panel',
    pushPanel: async () => {},
    ensureAgent: async () => agent,
    resumeSession: async () => ({ kind: 'success', text: 'resumed' }),
    isWorking: () => false,
    resetChat: () => {},
    lastOutput: () => undefined,
    liveAgent: () => undefined,
    sendLog: async () => ({ kind: 'success', text: 'sent' }),
    ...overrides,
  };
  const commands = new CommandRegistry();
  registerSurfaceCommands(commands, base);
  return { transport, commands, host: base };
}

describe('surface command set', () => {
  it('registers the full command set with panel categories', () => {
    const { commands } = makeCommands();
    const names = commands.list().map((command) => command.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'help',
        'panel',
        'group',
        'cancel',
        'cd',
        'repo',
        'status',
        'feishu-status',
        'schedule',
        'model',
        'export',
        'sessions',
        'resume',
        'clear',
        'new',
        'goal',
        'compact',
        'feedback',
        'permission',
        'plan',
      ]),
    );
    // The panel button set excludes the hidden-from-panel commands.
    const hidden = commands.list().filter((command) => command.hiddenFromPanel === true);
    expect(hidden.map((command) => command.name)).toEqual(
      expect.arrayContaining(['panel', 'resume', 'clear']),
    );
  });

  it('/help lists every command', async () => {
    const { commands } = makeCommands();
    const result = await commands.find('help')?.handler({
      chatId: 'oc_chat',
      senderOpenId: 'ou_user',
      rawInput: '',
    });
    expect(result?.kind).toBe('success');
    if (result?.kind === 'success') expect(result.text).toContain('dsh-feishu commands');
  });

  it('/log asks the host to send the dsh-feishu log', async () => {
    const { commands } = makeCommands();
    const result = await commands.find('log')?.handler({
      chatId: 'oc_chat',
      senderOpenId: 'ou_user',
      rawInput: '',
    });
    expect(result?.kind).toBe('success');
    if (result?.kind === 'success') expect(result.text).toContain('sent');
  });

  it('/group creates a group with the sender', async () => {
    const { transport, commands } = makeCommands();
    const result = await commands.find('group')?.handler({
      chatId: 'oc_chat',
      senderOpenId: 'ou_user',
      rawInput: '  my team ',
    });
    expect(transport.createdGroups).toEqual([{ name: 'my team', memberOpenIds: ['ou_user'] }]);
    expect(result?.kind).toBe('success');
  });

  it('/cancel stops the live agent', async () => {
    const { commands } = makeCommands();
    // The fake agent store only returns the agent for the mapped session.
    const result = await commands.find('cancel')?.handler({
      chatId: 'oc_chat',
      senderOpenId: 'ou_user',
      rawInput: '',
    });
    expect(result?.kind).toBe('success');
  });

  it('/cd sets the working directory and rebinds the session', async () => {
    const { mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const target = join(process.cwd(), '_dev', 'test-cmd-cd');
    mkdirSync(target, { recursive: true });
    const { commands } = makeCommands();
    const result = await commands.find('cd')?.handler({
      chatId: 'oc_chat',
      senderOpenId: 'ou_user',
      rawInput: target,
    });
    expect(result?.kind).toBe('success');
  });

  it('/cd rejects a missing directory', async () => {
    const { commands } = makeCommands();
    const result = await commands.find('cd')?.handler({
      chatId: 'oc_chat',
      senderOpenId: 'ou_user',
      rawInput: '/no/such/dir/anywhere',
    });
    expect(result?.kind).toBe('error');
  });

  it('/export sends the session log as a file', async () => {
    const { transport, commands } = makeCommands({
      readSession: async () => ({
        session: { id: 'feishu-session-1' },
        events: [
          {
            type: 'message',
            seq: 1,
            data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
          },
        ],
      }),
    });
    const result = await commands.find('export')?.handler({
      chatId: 'oc_chat',
      senderOpenId: 'ou_user',
      rawInput: '',
    });
    expect(transport.sentFiles).toHaveLength(1);
    expect(result?.kind).toBe('success');
  });

  it('/permission with no args opens the preset picker (pushPanel)', async () => {
    const pushed: unknown[] = [];
    const { commands } = makeCommands({
      permissionPresets: {
        names: ['read-only'],
        optionOf: (name) => ({ value: name }),
        current: () => 'read-only',
        set: () => {},
      },
      pushPanel: async (chatId, view) => {
        pushed.push({ chatId, view });
      },
    });
    const result = await commands.find('permission')?.handler({
      chatId: 'oc_chat',
      senderOpenId: 'ou_user',
      rawInput: '',
    });
    expect(pushed).toHaveLength(1);
    expect(result?.kind).toBe('success');
  });

  it('/model <provider>/<model> sets the default through the service', async () => {
    const saved: unknown[] = [];
    const { commands } = makeCommands({
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'a', model: 'b' }),
        saveSelection: async (selection) => {
          saved.push(selection);
        },
      },
    });
    const result = await commands.find('model')?.handler({
      chatId: 'oc_chat',
      senderOpenId: 'ou_user',
      rawInput: 'deepseek-official/deepseek-r1',
    });
    expect(saved).toEqual([{ provider: 'deepseek-official', model: 'deepseek-r1' }]);
    expect(result?.kind).toBe('success');
  });

  it('runHarnessCommand executes through the dsh registry', async () => {
    const executeCommand = vi.fn(
      async (_agent: Agent, line: string): Promise<CommandResult | undefined> =>
        line === '/goal set it' ? { kind: 'success', text: 'Goal set.' } : undefined,
    );
    const { host } = makeCommands({ executeCommand });
    const result = await runHarnessCommand(
      host,
      { chatId: 'oc_chat', rawInput: ' set it' },
      'goal',
    );
    expect(executeCommand).toHaveBeenCalledWith(expect.anything(), '/goal set it');
    expect(result).toEqual({ kind: 'success', text: 'Goal set.' });
  });

  it('runHarnessCommand reports when the registry is not mounted', async () => {
    const { host } = makeCommands();
    const result = await runHarnessCommand(host, { chatId: 'oc_chat', rawInput: '' }, 'goal');
    expect(result?.kind).toBe('error');
  });
});

describe('planModeResultText', () => {
  it('mirrors the harness /plan wording', () => {
    expect(planModeResultText(true, 'committed')).toBe('Plan mode on. Use /plan off to leave.');
    expect(planModeResultText(false, 'committed')).toBe('Plan mode off.');
    expect(planModeResultText(true, 'noop')).toBe('Plan mode is already active.');
  });
});
