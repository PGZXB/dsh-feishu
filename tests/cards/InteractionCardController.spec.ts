/**
 * Unit tests for the interaction card controller: approval and question
 * flows (single-select, multi-select, free-text), the card actions that
 * settle them, and the free-text answer capture.
 */

import { join } from 'node:path';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { describe, expect, it } from 'vitest';
import {
  InteractionCardController,
  type InteractionCardHost,
} from '../../src/cards/InteractionCardController.js';
import type { CardAction, CardJson, FeishuTransport } from '../../src/feishu/types.js';
import { SessionMap } from '../../src/session-map.js';

/** Records transport interactions for assertions. */
class RecordingTransport implements FeishuTransport {
  sentCards: CardJson[] = [];
  updatedCards: CardJson[] = [];
  sentTexts: Array<{ chatId: string; text: string }> = [];

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
  async createGroup(name: string, _memberOpenIds: readonly string[]): Promise<{ chatId: string }> {
    return { chatId: `oc_group_${name}` };
  }
  async sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
  }
  async sendFile(_chatId: string, _fileName: string, _content: string): Promise<void> {}
  async addReaction(_messageId: string, _emojiType: string): Promise<string | undefined> {
    return undefined;
  }
  async removeReaction(_messageId: string, _reactionId: string): Promise<void> {}
  async sendCard(_chatId: string, card: CardJson): Promise<{ messageId: string }> {
    this.sentCards.push(card);
    return { messageId: `msg-${this.sentCards.length}` };
  }
  async updateCard(_messageId: string, card: CardJson): Promise<void> {
    this.updatedCards.push(card);
  }
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
/** A minimal agent fake (session id only). */
function makeAgent(sessionId = 'feishu-session-1'): Agent {
  return {
    session: { id: sessionId },
    followup: () => {},
    cancel: () => {},
  } as unknown as Agent;
}

/** Build a controller wired to a recording transport + session map. */
function makeController(): {
  transport: RecordingTransport;
  controller: InteractionCardController;
  agent: Agent;
} {
  const transport = new RecordingTransport();
  const sessionMap = new SessionMap(join(process.cwd(), '_dev', 'test-interaction-map.json'));
  sessionMap.set('oc_chat', 'feishu-session-1');
  const agent = makeAgent();
  const host: InteractionCardHost = {
    transport,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    sessionMap,
    cardMentionFor: () => '',
    syncCard: () => {},
  };
  return { transport, controller: new InteractionCardController(host), agent };
}

function action(kind: string, extra: Record<string, string> = {}): CardAction {
  return {
    messageId: 'msg-1',
    chatId: 'oc_chat',
    operatorOpenId: 'ou_user',
    value: { kind, ...extra },
  };
}

describe('InteractionCardController', () => {
  it('posts an approval card and settles allowed-once on Allow', async () => {
    const h = makeController();
    const pending = h.controller.handleApprovalRequest({
      agent: h.agent,
      toolName: 'bash',
      reason: 'run a command',
    });
    expect(h.transport.sentCards).toHaveLength(1);
    expect(JSON.stringify(h.transport.sentCards[0]?.elements)).toContain('bash');
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.controller.handleCardAction(action('approval', { id: 'approval-1', decision: 'allow' }));
    await expect(pending).resolves.toBe('allowed-once');
    // The card is settled into its decided state (deferred macrotask).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.transport.updatedCards).toHaveLength(1);
  });

  it('settles rejected on Reject and cancelled on abort', async () => {
    const h = makeController();
    const controller = new AbortController();
    const pending = h.controller.handleApprovalRequest({
      agent: h.agent,
      toolName: 'bash',
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.controller.handleCardAction(action('approval', { id: 'approval-1', decision: 'reject' }));
    await expect(pending).resolves.toBe('rejected');
    const pending2 = h.controller.handleApprovalRequest({
      agent: h.agent,
      toolName: 'bash',
      signal: controller.signal,
    });
    // Let the second card post + register before aborting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending2).resolves.toBe('cancelled');
  });

  it('fails closed when the session has no chat', async () => {
    const h = makeController();
    const agent = makeAgent();
    const unknown = { ...agent, session: { id: 'feishu-session-999' } } as Agent;
    await expect(
      h.controller.handleApprovalRequest({ agent: unknown, toolName: 'bash' }),
    ).resolves.toBe('unavailable');
  });

  it('single-select question answers with the chosen option label', async () => {
    const h = makeController();
    const pending = h.controller.askQuestions({
      agent: h.agent,
      questions: [{ id: 'q1', question: 'Which one?', options: [{ label: 'A' }, { label: 'B' }] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.controller.handleCardAction(action('question', { id: 'q1', answer: 'B' }));
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['B'] }],
    });
  });

  it('multi-select toggles accumulate and submit settles the selection', async () => {
    const h = makeController();
    const pending = h.controller.askQuestions({
      agent: h.agent,
      questions: [
        {
          id: 'q1',
          question: 'Pick any',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.controller.handleCardAction(action('question-toggle', { id: 'q1', option: 'A' }));
    await h.controller.handleCardAction(action('question-toggle', { id: 'q1', option: 'B' }));
    // Submit must come from the NEWEST card (the toggles retargeted it).
    const newestId = `msg-${h.transport.sentCards.length}`;
    h.controller.handleCardAction({
      messageId: newestId,
      chatId: 'oc_chat',
      operatorOpenId: 'ou_user',
      value: { kind: 'question-submit', id: 'q1' },
    });
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: ['A', 'B'] }],
    });
  });

  it('free-text question answers via the next chat message', async () => {
    const h = makeController();
    const pending = h.controller.askQuestions({
      agent: h.agent,
      questions: [{ id: 'q1', question: 'Your feedback?' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.controller.answerFreeText('oc_chat', 'it rocks')).toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: 'it rocks' }],
    });
    // A second message is not consumed.
    expect(h.controller.answerFreeText('oc_chat', 'again')).toBe(false);
  });

  it('question-cancel settles a free-text question as cancelled', async () => {
    const h = makeController();
    const pending = h.controller.askQuestions({
      agent: h.agent,
      questions: [{ id: 'q1', question: 'Your feedback?' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.controller.handleCardAction(action('question-cancel', { id: 'q1' }));
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'q1', selected: [], custom: undefined }],
    });
  });

  it('answers cancelled when no chat maps to the agent', async () => {
    const h = makeController();
    const agent = makeAgent('feishu-session-999');
    await expect(
      h.controller.askQuestions({ agent, questions: [{ id: 'q1', question: 'Q' }] }),
    ).resolves.toEqual({ answers: [{ id: 'q1', selected: [] }] });
  });
});
