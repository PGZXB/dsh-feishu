/**
 * Surface command registry: plugin-owned slash commands plus the DSH
 * passthrough fallback.
 *
 * Every command declares a button label and category so the control panel
 * can render the full command set as buttons (everything-is-a-card); the
 * button and the slash line execute the same handler.
 *
 * @module @dsh-feishu/dsh-feishu/commands
 */

/** Command invocation context. */
export interface CommandInvocation {
  /** The chat the command arrived in. */
  readonly chatId: string;
  /** The sender's open id. */
  readonly senderOpenId: string;
  /** Text following the command name (separator whitespace included). */
  readonly rawInput: string;
}

/** A settled command outcome, rendered by the surface. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text: string }
  | { readonly kind: 'error'; readonly text: string };

/** One surface command. */
export interface SurfaceCommand {
  /** Lowercase name without the leading slash. */
  readonly name: string;
  /** Human-readable summary. */
  readonly description: string;
  /** Panel category grouping. */
  readonly category: 'session' | 'chat' | 'system';
  /** Button label on the control panel; defaults to the command name. */
  readonly buttonLabel?: string;
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>;
}

/** A parsed slash line. */
export interface ParsedSlash {
  readonly name: string;
  readonly rawInput: string;
}

/**
 * Parse a slash line: `/name rest`. Not a command when the line does not
 * start with `/` or the name is empty.
 * @param line - the trimmed message text.
 * @returns the parsed command, or `undefined`.
 */
export function parseSlash(line: string): ParsedSlash | undefined {
  if (!line.startsWith('/')) return undefined;
  const match = /^\/([A-Za-z0-9_-]+)([\s\S]*)$/.exec(line);
  if (match === null || match[1] === undefined) return undefined;
  return { name: match[1].toLowerCase(), rawInput: match[2] ?? '' };
}

/** An ordered command registry. */
export class CommandRegistry {
  private readonly byName = new Map<string, SurfaceCommand>();
  private readonly order: SurfaceCommand[] = [];

  /** Register a command; a duplicate name replaces the previous entry. */
  register(command: SurfaceCommand): void {
    if (!this.byName.has(command.name)) this.order.push(command);
    this.byName.set(command.name, command);
  }

  /** All commands, in registration order. */
  list(): readonly SurfaceCommand[] {
    return this.order;
  }

  /** One command by name, or `undefined`. */
  find(name: string): SurfaceCommand | undefined {
    return this.byName.get(name);
  }
}
