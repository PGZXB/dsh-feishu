/**
 * Panel state-machine shared types: the view stack model, the input/confirm
 * sub-view copy, and the marker payloads stamped on card actions.
 *
 * The panel is a state machine — one authoritative view stack PER PANEL CARD
 * (each card owns its stack: `Map<chatId, Map<messageId, PanelView[]>>`), one
 * render path — NOT a set of ad-hoc patches. Every view renders in place on
 * the card it was tapped on; a button PUSHES a sub-view, Back POPS, completion
 * pops to the menu root.
 *
 * @module @dsh-feishu/dsh-feishu/panel/types
 */

import { t } from '../i18n/index.js';
import type { MessageKey } from '../i18n/index.js';

/**
 * The panel card state machine view (single authoritative panel state, one
 * render path — the same rule as `ChatCardState`). `menu` is the root; a
 * button PUSHES an `input`/`confirm` sub-view, completion/back POPS to
 * `menu`. Every view renders in place on the SAME panel card.
 */
export type PanelView =
  | { readonly kind: 'menu'; readonly page: number }
  | { readonly kind: 'input'; readonly command: PanelInputCommand; readonly sessionId?: string }
  | { readonly kind: 'confirm'; readonly command: 'clear' | 'compact' }
  | { readonly kind: 'sessions'; readonly archived: boolean; readonly query?: string }
  | { readonly kind: 'session-detail'; readonly sessionId: string }
  | {
      readonly kind: 'picker';
      readonly picker: 'repo' | 'model' | 'permission';
      readonly page: number;
      /** Custom repo roots to scan (a typed `/repo <path>` passes one root);
       *  omit to use the deployment's default `repoRoots`. */
      readonly roots?: readonly string[];
    };

/** Commands whose panel button opens a text-input sub-view. */
export type PanelInputCommand =
  | 'cd'
  | 'group'
  | 'goal'
  | 'feedback'
  | 'rename-session'
  | 'find-session';

/** Narrow a panel command marker to the input commands. */
export function isPanelInputCommand(value: string | undefined): value is PanelInputCommand {
  return (
    value === 'cd' ||
    value === 'group' ||
    value === 'goal' ||
    value === 'feedback' ||
    value === 'rename-session' ||
    value === 'find-session'
  );
}

/** Static, locale-independent half of the input sub-view spec. */
interface PanelInputSpecEntry {
  /** The form field name echoed back to the handler. */
  readonly fieldName: string;
  /** Catalog key of the view title. */
  readonly titleKey: MessageKey;
  /** Catalog key of the helper line under the title. */
  readonly hintKey: MessageKey;
  /** Catalog key of the empty-form placeholder. */
  readonly placeholderKey: MessageKey;
  /** Catalog key of the submit button label. */
  readonly submitKey: MessageKey;
}

/** Which catalog keys each input command draws its copy from. */
export const PANEL_INPUT_SPEC: Record<PanelInputCommand, PanelInputSpecEntry> = {
  cd: {
    fieldName: 'path',
    titleKey: 'command.input.cd.title',
    hintKey: 'command.input.cd.hint',
    placeholderKey: 'command.input.cd.placeholder',
    submitKey: 'command.input.cd.submit',
  },
  group: {
    fieldName: 'name',
    titleKey: 'command.input.group.title',
    hintKey: 'command.input.group.hint',
    placeholderKey: 'command.input.group.placeholder',
    submitKey: 'command.input.group.submit',
  },
  goal: {
    fieldName: 'goal',
    titleKey: 'command.input.goal.title',
    hintKey: 'command.input.goal.hint',
    placeholderKey: 'command.input.goal.placeholder',
    submitKey: 'command.input.goal.submit',
  },
  feedback: {
    fieldName: 'feedback',
    titleKey: 'command.input.feedback.title',
    hintKey: 'command.input.feedback.hint',
    placeholderKey: 'command.input.feedback.placeholder',
    submitKey: 'command.input.feedback.submit',
  },
  'rename-session': {
    fieldName: 'title',
    titleKey: 'command.input.rename-session.title',
    hintKey: 'command.input.rename-session.hint',
    placeholderKey: 'command.input.rename-session.placeholder',
    submitKey: 'command.input.rename-session.submit',
  },
  'find-session': {
    fieldName: 'query',
    titleKey: 'command.input.find-session.title',
    hintKey: 'command.input.find-session.hint',
    placeholderKey: 'command.input.find-session.placeholder',
    submitKey: 'command.input.find-session.submit',
  },
};

/** Resolved copy for an input sub-view (translated at call time). */
export function panelInputCopy(command: PanelInputCommand): {
  readonly title: string;
  readonly hint: string;
  readonly fieldName: string;
  readonly placeholder: string;
  readonly submitLabel: string;
} {
  const spec = PANEL_INPUT_SPEC[command];
  return {
    fieldName: spec.fieldName,
    title: t(spec.titleKey),
    hint: t(spec.hintKey),
    placeholder: t(spec.placeholderKey),
    submitLabel: t(spec.submitKey),
  };
}

/** Static, locale-independent half of the confirm sub-view spec. */
interface PanelConfirmSpecEntry {
  /** Catalog key of the view title. */
  readonly titleKey: MessageKey;
  /** Catalog key of the question body. */
  readonly messageKey: MessageKey;
  /** Catalog key of the confirm button label. */
  readonly confirmKey: MessageKey;
}

/** Which catalog keys each confirm command draws its copy from. */
export const PANEL_CONFIRM_SPEC: Record<'clear' | 'compact', PanelConfirmSpecEntry> = {
  clear: {
    titleKey: 'command.confirm.clear.title',
    messageKey: 'command.confirm.clear.message',
    confirmKey: 'command.confirm.clear.submit',
  },
  compact: {
    titleKey: 'command.confirm.compact.title',
    messageKey: 'command.confirm.compact.message',
    confirmKey: 'command.confirm.compact.submit',
  },
};

/** Resolved copy for a confirm sub-view (translated at call time). */
export function panelConfirmCopy(command: 'clear' | 'compact'): {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
} {
  const spec = PANEL_CONFIRM_SPEC[command];
  return {
    title: t(spec.titleKey),
    message: t(spec.messageKey),
    confirmLabel: t(spec.confirmKey),
  };
}
