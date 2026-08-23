/**
 * InteractionCardController: the approval/question card flows.
 *
 * The surface's answerers (`handleApprovalRequest`, `askQuestions`) post a
 * card, wait for the card callback (or timeout / abort), and settle exactly
 * once — through the {@link InteractionRegistry}. This controller owns those
 * flows plus the multi-select / free-text question state and the
 * approval/question card actions, behind the {@link InteractionCardHost}
 * seam. The Bridge keeps only the message routing that feeds it (a free-text
 * answer arrives as the next chat message).
 *
 * @module @dsh-feishu/dsh-feishu/cards/InteractionCardController
 */

import type {
  ApprovalOutcomeLike,
  ApprovalRequestLike,
  AskQuestionItemLike,
  AskQuestionsAnswerLike,
  AskQuestionsRequestLike,
} from '../bridge.js';
import type { CardAction, FeishuTransport, SentCard } from '../feishu/types.js';
import type { SessionMap } from '../session-map.js';
import { InteractionRegistry } from './interactions.js';
import {
  buildApprovalCard,
  buildApprovalDecidedCard,
  buildQuestionAnsweredCard,
  buildQuestionCard,
  type QuestionView,
} from './render.js';

/** Logger surface the interaction controller needs. */
export interface InteractionLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Debug tracing (printed only when FEISHU_DEBUG=1). */
  debug(message: string): void;
}

/**
 * What the interaction card flows need from the rest of the surface. The
 * Bridge implements this; the controller never touches Bridge internals
 * directly (structural types avoid a circular import).
 */
export interface InteractionCardHost {
  readonly transport: FeishuTransport;
  readonly logger: InteractionLogger;
  readonly sessionMap: SessionMap;
  /** Proactive @-mention prefix for a chat in groups (card-markdown form). */
  cardMentionFor(chatId: string): string;
  /** Re-assert the streaming card after an interaction settles (Lark can
   *  restore the pre-click streaming card otherwise — botmux rule). */
  syncCard(chatId: string): void;
}

/** The interaction card controller. One instance per bridge. */
export class InteractionCardController {
  private readonly interactions = new InteractionRegistry();
  /** Multi-select question state per request id (toggle + submit). */
  private readonly questionState = new Map<
    string,
    {
      readonly chatId: string;
      readonly view: QuestionView;
      selection: string[];
      /** The card the interaction currently targets — retargeted when the
       *  multi-select card is re-posted with checkmarks, so the finalize
       *  update lands on the newest card (user report: answered cards kept
       *  their buttons because the initial message id went stale). */
      messageId: string;
    }
  >();
  /** Chats awaiting a free-text question answer (request id per chat). */
  private readonly awaitingQuestionAnswers = new Map<string, { readonly requestId: string }>();
  /** Monotonic approval request counter (card callback correlation ids). */
  private approvalSeq = 0;

  constructor(private readonly host: InteractionCardHost) {}

  /** Detach every pending interaction (bridge disposal). */
  dispose(): void {
    this.interactions.dispose();
  }

  /**
   * Handle one `approval/request` (the surface's answerer): map the agent to
   * its chat, post an approval card, and wait for the card callback (or
   * timeout/abort → `'cancelled'`). Fail-closed `'unavailable'` when the
   * chat is unknown or the card cannot be posted.
   * @param request - the approval request.
   * @returns the settlement outcome.
   */
  async handleApprovalRequest(request: ApprovalRequestLike): Promise<ApprovalOutcomeLike> {
    const chatId = this.host.sessionMap.chatFor(String(request.agent.session.id));
    if (chatId === undefined) {
      this.host.logger.warn(
        `approval request for session ${String(request.agent.session.id)} has no chat; failing closed`,
      );
      return 'unavailable';
    }
    this.approvalSeq += 1;
    const requestId = `approval-${this.approvalSeq}`;
    this.host.logger.debug(
      `approval request ${requestId} for session ${String(request.agent.session.id)} -> chat ${chatId} (tool ${request.toolName})`,
    );
    let messageId: string;
    try {
      const sent = await this.host.transport.sendCard(
        chatId,
        buildApprovalCard(
          request.toolName,
          request.reason,
          requestId,
          this.host.cardMentionFor(chatId),
        ),
      );
      messageId = sent.messageId;
    } catch (error: unknown) {
      this.host.logger.warn(`approval card send failed: ${String(error)}`);
      return 'unavailable';
    }
    return new Promise<ApprovalOutcomeLike>((resolve) => {
      this.interactions.register(requestId, chatId, messageId, (outcome) => {
        this.host.logger.debug(`approval ${requestId} settled: ${String(outcome)}`);
        // Turn the card into its static decided state, deferred out of the
        // card-callback ACK (botmux rule), then re-assert the streaming card.
        const settled: ApprovalOutcomeLike = outcome as ApprovalOutcomeLike;
        setTimeout(() => {
          void this.host.transport
            .updateCard(messageId, buildApprovalDecidedCard(settled))
            .then(() => this.host.syncCard(chatId))
            .catch((error: unknown) => {
              this.host.logger.warn(`approval card settle update failed: ${String(error)}`);
              this.host.syncCard(chatId);
            });
        }, 0);
        resolve(settled);
      });
      if (request.signal !== undefined) {
        request.signal.addEventListener('abort', () => {
          this.interactions.abort(requestId, 'cancelled');
        });
      }
    });
  }

  /**
   * Answer one `AskUserQuestionRequest` as the surface's userQuestions
   * provider: post a question card per item and collect the answers through
   * card callbacks (or the next chat message for free-text questions).
   * @param request - the questions to ask.
   * @returns the structured answers.
   */
  async askQuestions(request: AskQuestionsRequestLike): Promise<AskQuestionsAnswerLike> {
    const agent = request.agent;
    const chatId =
      agent === undefined ? undefined : this.host.sessionMap.chatFor(String(agent.session.id));
    if (chatId === undefined) {
      this.host.logger.warn('user question has no chat to render into; answering cancelled');
      return {
        answers: request.questions.map((question) => ({ id: question.id, selected: [] })),
      };
    }
    this.host.logger.debug(
      `question request: ${request.questions.length} item(s) -> chat ${chatId}`,
    );
    const answers = new Map<string, { readonly id: string; selected: string[]; custom?: string }>();
    let resolveAllPromise!: () => void;
    const allDone = new Promise<void>((resolve) => {
      resolveAllPromise = resolve;
    });
    let pendingCount = request.questions.length;
    let settled = false;
    const resolveAll = (): void => {
      if (settled) return;
      settled = true;
      resolveAllPromise();
    };
    const settleOne = (answer: {
      readonly id: string;
      selected: string[];
      custom?: string;
    }): void => {
      if (answers.has(answer.id)) return;
      this.host.logger.debug(
        `question ${answer.id} settled: ${answer.selected.join(', ') || answer.custom || '(empty)'}`,
      );
      answers.set(answer.id, answer);
      pendingCount -= 1;
      if (pendingCount <= 0) resolveAll();
    };
    const viewOf = (question: AskQuestionItemLike): QuestionView => ({
      id: question.id,
      question: question.question,
      detail: question.detail,
      options: question.options ?? [],
      multiSelect: question.multiSelect ?? false,
    });
    for (const question of request.questions) {
      const requestId = `question-${question.id}`;
      const view = viewOf(question);
      let sent: SentCard;
      try {
        sent = await this.host.transport.sendCard(
          chatId,
          buildQuestionCard(view, [], this.host.cardMentionFor(chatId)),
        );
      } catch (error: unknown) {
        this.host.logger.warn(`question card send failed: ${String(error)}`);
        settleOne({ id: question.id, selected: [] });
        continue;
      }
      const messageId = sent.messageId;
      // Once answered, the card becomes a static confirmation (no buttons —
      // further taps do nothing, user report). Deferred out of the card
      // callback ACK. The target is the LATEST card the interaction points
      // at (a multi-select re-post retargets it), not the initial post.
      const finalizeCard = (targetMessageId: string, answerText: string): void => {
        setTimeout(() => {
          void this.host.transport
            .updateCard(targetMessageId, buildQuestionAnsweredCard(question.question, answerText))
            .catch((error: unknown) => {
              this.host.logger.warn(`question card settle update failed: ${String(error)}`);
            });
        }, 0);
      };
      if (view.options.length === 0) {
        // Free-text: await the next message in this chat.
        this.awaitingQuestionAnswers.set(chatId, { requestId });
        this.interactions.register(requestId, chatId, messageId, (outcome) => {
          const pending = this.awaitingQuestionAnswers.get(chatId);
          if (pending?.requestId === requestId) this.awaitingQuestionAnswers.delete(chatId);
          const cancelled = outcome === 'cancelled';
          const text = cancelled ? '' : outcome;
          finalizeCard(messageId, cancelled ? 'cancelled' : outcome);
          settleOne({ id: question.id, selected: [], ...(text === '' ? {} : { custom: text }) });
        });
        continue;
      }
      if (view.multiSelect) {
        this.questionState.set(requestId, { chatId, view, selection: [], messageId });
        this.interactions.register(requestId, chatId, messageId, () => {
          const state = this.questionState.get(requestId);
          this.questionState.delete(requestId);
          const selected = state?.selection ?? [];
          finalizeCard(
            state?.messageId ?? messageId,
            selected.length === 0 ? 'cancelled' : selected.join(', '),
          );
          settleOne({ id: question.id, selected });
        });
        continue;
      }
      // Single-select: the chosen option label is the outcome.
      this.interactions.register(requestId, chatId, messageId, (outcome) => {
        finalizeCard(messageId, outcome);
        settleOne({ id: question.id, selected: [outcome] });
      });
    }
    if (request.signal !== undefined) {
      request.signal.addEventListener('abort', () => {
        for (const question of request.questions) {
          const requestId = `question-${question.id}`;
          this.awaitingQuestionAnswers.delete(chatId);
          if (!answers.has(question.id)) settleOne({ id: question.id, selected: [] });
          this.interactions.abort(requestId, 'cancelled');
        }
        resolveAll();
      });
    }
    await allDone;
    return {
      answers: request.questions.map(
        (question) => answers.get(question.id) ?? { id: question.id, selected: [] },
      ),
    };
  }

  /**
   * A free-text question answer arrives as the next chat message. Returns
   * whether the message was consumed as an answer (the caller must NOT turn
   * it into a turn).
   * @param chatId - the chat.
   * @param text - the message text (the answer).
   * @returns whether a question was awaiting and answered.
   */
  answerFreeText(chatId: string, text: string): boolean {
    const awaiting = this.awaitingQuestionAnswers.get(chatId);
    if (awaiting === undefined) return false;
    this.awaitingQuestionAnswers.delete(chatId);
    this.interactions.resolveDirect(awaiting.requestId, chatId, text);
    return true;
  }

  /**
   * Handle one interaction card action (approval / question /
   * question-toggle / question-submit / question-cancel). These settle
   * pending interactions; other kinds are ignored (the Bridge routes them).
   * @param action - the normalized card callback.
   */
  async handleCardAction(action: CardAction): Promise<void> {
    switch (action.value.kind) {
      case 'approval': {
        const id = action.value.id;
        const decision = action.value.decision;
        if (id === undefined || (decision !== 'allow' && decision !== 'reject')) return;
        this.interactions.resolveOnce(
          id,
          action.chatId,
          action.messageId,
          decision === 'allow' ? 'allowed-once' : 'rejected',
        );
        return;
      }
      case 'question': {
        // Single-select: the chosen option label is the answer.
        const id = action.value.id;
        const answer = action.value.answer;
        if (id === undefined || answer === undefined) return;
        this.interactions.resolveOnce(`question-${id}`, action.chatId, action.messageId, answer);
        return;
      }
      case 'question-toggle': {
        // Multi-select: flip one option and re-post the card with
        // checkmarks; the newest card becomes the interaction target.
        const id = `question-${action.value.id ?? ''}`;
        const option = action.value.option;
        const state = this.questionState.get(id);
        if (state === undefined || option === undefined) return;
        state.selection = state.selection.includes(option)
          ? state.selection.filter((entry) => entry !== option)
          : [...state.selection, option];
        try {
          const sent = await this.host.transport.sendCard(
            state.chatId,
            buildQuestionCard(state.view, state.selection),
          );
          this.interactions.retarget(id, sent.messageId);
          state.messageId = sent.messageId;
        } catch (error: unknown) {
          this.host.logger.warn(`question toggle re-post failed: ${String(error)}`);
        }
        return;
      }
      case 'question-submit': {
        const id = `question-${action.value.id ?? ''}`;
        this.interactions.resolveOnce(id, action.chatId, action.messageId, 'submit');
        return;
      }
      case 'question-cancel': {
        const id = `question-${action.value.id ?? ''}`;
        this.awaitingQuestionAnswers.delete(action.chatId);
        this.interactions.resolveOnce(id, action.chatId, action.messageId, 'cancelled');
        return;
      }
      default:
        // Not an interaction action (streaming/panel) — ignore.
        return;
    }
  }
}
