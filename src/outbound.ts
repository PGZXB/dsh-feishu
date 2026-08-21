/**
 * Outbound files/images: a `send_file` tool the agent can call to deliver a
 * workspace file or image to the Feishu chat.
 *
 * dsh has no host-level "agent produced a file" event, so instead of
 * guessing from `tool/result` or fs observation, the surface registers a
 * first-class tool the agent calls deliberately. The tool resolves the path
 * against the chat's pinned working directory, reads the bytes, classifies
 * image vs file by extension + magic bytes, uploads through the
 * message-resource API, posts a native Feishu image/file message, and shows
 * a `📤 Sent` receipt card. Active and self-describing — no heuristics, no
 * false positives.
 *
 * @module @dsh-feishu/dsh-feishu/outbound
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { buildSentFileCard } from './cards/render.js';
import type { FeishuTransport } from './feishu/types.js';
import type { SessionMap } from './session-map.js';

/** Image containers recognized by `sniffExtension` (sent as image messages). */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'gif', 'webp']);

/** A minimal logger seam for debug tracing (FEISHU_DEBUG-gated upstream). */
export interface OutboundLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Host capabilities the `send_file` tool closes over. */
export interface OutboundHost {
  /** The Feishu transport used to upload + post the message (incl. cards). */
  readonly transport: FeishuTransport;
  /** The chat→session map (to resolve the session's chat). */
  readonly sessionMap: SessionMap;
  /** The Feishu app id the surface runs as (for the receipt card). */
  readonly appId?: string;
  /** Minimal logger. */
  readonly logger: OutboundLogger;
}

/** Resolve an agent session id to its Feishu chat id via the session map. */
function chatForSession(sessionMap: SessionMap, sessionId: string): string | undefined {
  return sessionMap.chatFor(sessionId);
}

/** Classify a path's extension as an image container (image message) or file. */
export function isImagePath(path: string): boolean {
  const ext = basename(path).split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Register the `send_file` tool on the provided context. Feature-detect:
 * `tools` is an optional dsh-base service — when absent, the surface logs
 * loudly and skips registration so the agent never sees a broken tool.
 * @param ctx - the cordis context (the surface's `apply` context).
 * @param host - the closed-over host capabilities (transport, session map).
 * @returns a disposer that unregisters the tool, or `undefined` when the
 *   `tools` service is not mounted.
 */
export function registerSendFileTool(ctx: Context, host: OutboundHost): (() => void) | undefined {
  const tools = ctx.get('tools');
  if (tools === undefined) {
    host.logger.warn('outbound send_file: tools service absent, tool not registered');
    return undefined;
  }
  return tools.register(
    defineTool({
      name: 'send_file',
      description:
        'Send a file or image from the workspace to the chat. The path is relative to the ' +
        'pinned working directory. The user receives it as a native Feishu ' +
        'image/file message. Use when the user asked for (or would benefit from) a concrete ' +
        'artifact — a plot, screenshot, generated document, report, CSV, etc.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Workspace-relative path of the file/image to send.',
        },
        description: {
          type: 'string',
          description: 'A short explanation of why you are sending it (shown on the receipt card).',
        },
      },
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          const name =
            typeof value === 'object' && value !== null && 'name' in value
              ? String((value as { name: unknown }).name ?? '')
              : '';
          return [
            {
              type: 'text',
              text: name === '' ? 'Sent the file to the chat.' : `Sent ${name} to the chat.`,
            },
          ];
        },
      },
      async execute(args: unknown, exec: ToolRunContext) {
        const { path, description } = args as { path?: string; description?: string };
        if (typeof path !== 'string' || path === '') {
          throw new Error('send_file: `path` is required');
        }
        const cwd = exec.agent?.session.header.cwd;
        if (cwd === undefined || exec.agent === undefined) {
          throw new Error('send_file: no working directory for this session');
        }
        const sessionId = exec.agent.session.id;
        const chatId = chatForSession(host.sessionMap, sessionId);
        if (chatId === undefined) {
          throw new Error('send_file: no chat mapped for this session');
        }
        const filePath = join(cwd, path);
        let bytes: Uint8Array;
        try {
          const info = await stat(filePath);
          if (!info.isFile()) throw new Error('not a file');
          bytes = new Uint8Array(await readFile(filePath));
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          host.logger.warn(`outbound send_file ${path}: unreadable (${msg})`);
          throw new Error(`send_file: could not read '${path}' (${msg})`);
        }
        const name = basename(filePath);
        const isImage = isImagePath(path);
        host.logger.debug(
          `outbound send_file ${name}: ${bytes.length} bytes, ${isImage ? 'image' : 'file'} -> chat ${chatId}`,
        );
        // Upload + post. The transport implementation picks the right API:
        // image → im.v1.image.create + 'image' message; file → im.v1.file.create
        // + 'file' message. Classification by extension (image) vs everything
        // else (file — the resource API serves arbitrary bytes, incl. audio
        // and video).
        try {
          if (isImage) {
            await host.transport.sendImage(chatId, name, bytes);
          } else {
            await host.transport.sendFile(chatId, name, bytes);
          }
          host.logger.debug(`outbound send_file ${name}: sent to chat ${chatId}`);
          // Acknowledge with a small receipt card (best-effort — a card post
          // failure must not fail the tool; the message itself was sent).
          try {
            await host.transport.sendCard(
              chatId,
              buildSentFileCard(name, typeof description === 'string' ? description : undefined),
            );
          } catch (cardError: unknown) {
            host.logger.warn(
              `outbound send_file ${name}: receipt card failed (${String(cardError)})`,
            );
          }
          return { name, sent: true };
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          host.logger.warn(`outbound send_file ${name}: send failed (${msg})`);
          throw new Error(`send_file: failed to send '${name}' (${msg})`);
        }
      },
    }),
  );
}
