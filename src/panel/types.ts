/**
 * Panel state-machine shared types: the view stack model, the input/confirm
 * sub-view copy, and the marker payloads stamped on card actions.
 *
 * The panel is a state machine — one authoritative view stack per chat, one
 * render path — NOT a set of ad-hoc patches. Every view renders in place on
 * the SAME panel card; a button PUSHES a sub-view, Back POPS, completion
 * pops to the menu root.
 *
 * @module @dsh-feishu/dsh-feishu/panel/types
 */

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

/** Text-input sub-view copy per command. */
export const PANEL_INPUT_SPEC: Record<
  PanelInputCommand,
  {
    readonly title: string;
    readonly hint: string;
    readonly fieldName: string;
    readonly placeholder: string;
    readonly submitLabel: string;
  }
> = {
  cd: {
    title: '📁 Change working directory',
    hint: 'Send the absolute (or `~`) path to the project directory.',
    fieldName: 'path',
    placeholder: 'e.g. /home/user/projects/demo',
    submitLabel: 'Set directory',
  },
  group: {
    title: '👥 New group',
    hint: 'Send the group name to create and join.',
    fieldName: 'name',
    placeholder: 'e.g. my team',
    submitLabel: 'Create group',
  },
  goal: {
    title: '🎯 Goal',
    hint: 'Send the goal text for the ongoing task.',
    fieldName: 'goal',
    placeholder: 'e.g. fix the build',
    submitLabel: 'Set goal',
  },
  feedback: {
    title: '💬 Feedback',
    hint: 'Send your feedback text.',
    fieldName: 'feedback',
    placeholder: 'Type feedback…',
    submitLabel: 'Send feedback',
  },
  'rename-session': {
    title: '✏️ Rename session',
    hint: 'Send the new title for this session.',
    fieldName: 'title',
    placeholder: 'New title',
    submitLabel: 'Rename',
  },
  'find-session': {
    title: '🔎 Find session',
    hint: 'Send a session id or part of its title to filter the list.',
    fieldName: 'query',
    placeholder: 'e.g. feishu-session-1 or "old project"',
    submitLabel: 'Find',
  },
};

/** Confirm sub-view copy per command. */
export const PANEL_CONFIRM_SPEC: Record<
  'clear' | 'compact',
  { readonly title: string; readonly message: string; readonly confirmLabel: string }
> = {
  clear: {
    title: '✨ New chat',
    message:
      'Start a NEW conversation? The previous session stays saved (resumable via /sessions).',
    confirmLabel: 'Start new chat',
  },
  compact: {
    title: '🧹 Compact',
    message:
      'Compact older conversation history into a summary? The chat is unavailable while it runs.',
    confirmLabel: 'Compact now',
  },
};
