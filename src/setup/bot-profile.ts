/**
 * Guided bot-profile prompts: when creating a new app, the wizard asks for
 * the bot's name, avatar image, and description — an empty input (just
 * Enter) accepts the default. Values already provided on the command line
 * (`--app-name` / `--avatar` / `--description`) skip their prompt.
 * Non-interactive runs (stdin is not a TTY, e.g. CI or scripts) skip the
 * prompts entirely.
 *
 * The merge is a pure function (`mergeBotProfile`) so it is fully
 * unit-testable; prompting is a thin readline wrapper around it, mirroring
 * `guided-config.ts`.
 *
 * @module @dsh-feishu/dsh-feishu/setup/bot-profile
 */

import { createInterface } from 'node:readline';
import { DEFAULT_APP_NAME } from './manifest.js';

/** The effective bot profile used to create the app. */
export interface BotProfile {
  readonly name: string;
  readonly avatarFilePath?: string;
  readonly description?: string;
}

/** Values the caller already has (from CLI flags). */
export interface BotProfileInputs {
  readonly appName?: string;
  readonly avatarFilePath?: string;
  readonly description?: string;
}

/** One raw answer from the user; an empty string means "use the default". */
export interface BotProfileAnswers {
  appName?: string;
  avatarFilePath?: string;
  description?: string;
}

/**
 * Merge CLI-provided values (highest priority), prompted answers, and
 * defaults. Empty/blank answers keep the defaults.
 * @param inputs - values already known from the command line.
 * @param answers - the raw inputs (empty string = default).
 */
export function mergeBotProfile(inputs: BotProfileInputs, answers: BotProfileAnswers): BotProfile {
  const name = inputs.appName?.trim() || answers.appName?.trim() || DEFAULT_APP_NAME;
  const avatarFilePath = inputs.avatarFilePath?.trim() || answers.avatarFilePath?.trim() || '';
  const description = inputs.description?.trim() || answers.description?.trim() || '';
  return {
    name,
    ...(avatarFilePath !== '' ? { avatarFilePath } : {}),
    ...(description !== '' ? { description } : {}),
  };
}

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

/**
 * Ask for the bot-profile values the CLI did not already provide. Returns
 * no answers when stdin is not a TTY (CI / scripts) so nothing blocks.
 * @param inputs - values already known from the command line (skipped).
 */
export async function promptBotProfile(inputs: BotProfileInputs): Promise<BotProfileAnswers> {
  if (!process.stdin.isTTY) return {};
  const answers: BotProfileAnswers = {};
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!inputs.appName?.trim()) {
      answers.appName = await ask(rl, `Bot app name [${DEFAULT_APP_NAME}]: `);
    }
    if (!inputs.avatarFilePath?.trim()) {
      answers.avatarFilePath = await ask(
        rl,
        'Bot avatar image path (PNG; empty = bundled dsh wordmark): ',
      );
    }
    if (!inputs.description?.trim()) {
      answers.description = await ask(
        rl,
        'Bot description (empty = "A dsh agent surface on Feishu."): ',
      );
    }
  } finally {
    rl.close();
  }
  return answers;
}
