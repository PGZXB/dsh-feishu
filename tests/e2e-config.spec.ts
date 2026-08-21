import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadE2eConfig } from '../e2e/lib/config.js';

describe('e2e config', () => {
  it('requires E2E_CHAT', () => {
    expect(() => loadE2eConfig({})).toThrow(/E2E_CHAT is required/);
  });

  it('applies defaults', () => {
    const cfg = loadE2eConfig({ E2E_CHAT: 'Test Bot' });
    expect(cfg.chatName).toBe('Test Bot');
    expect(cfg.headless).toBe(true);
    expect(cfg.video).toBe('mp4');
    expect(cfg.screenshots).toBe('on');
    expect(cfg.baseUrl).toBe('https://www.feishu.cn/');
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.reportDir).toBe(join(process.cwd(), '_dev', 'e2e-report'));
    expect(cfg.sessionState).toBe(join(process.cwd(), '_dev', 'e2e-session', 'state.json'));
    expect(cfg.appId).toBeUndefined();
  });

  it('reads explicit values and app-credential fallbacks', () => {
    const cfg = loadE2eConfig({
      E2E_CHAT: 'Bot',
      E2E_HEADED: '1',
      E2E_VIDEO: 'mp4',
      E2E_SCREENSHOTS: 'failure',
      E2E_REPORT_DIR: '/tmp/r',
      E2E_SESSION_STATE: '/tmp/s.json',
      E2E_TIMEOUT_MS: '5000',
      E2E_APP_ID: 'cli_x',
      E2E_APP_SECRET: 'secret',
    });
    expect(cfg.headless).toBe(false);
    expect(cfg.video).toBe('mp4');
    expect(cfg.screenshots).toBe('failure');
    expect(cfg.reportDir).toBe('/tmp/r');
    expect(cfg.timeoutMs).toBe(5_000);
    expect(cfg.appId).toBe('cli_x');
  });

  it('falls back to FEISHU_APP_ID / FEISHU_APP_SECRET', () => {
    const cfg = loadE2eConfig({ E2E_CHAT: 'Bot', FEISHU_APP_ID: 'cli_f', FEISHU_APP_SECRET: 's' });
    expect(cfg.appId).toBe('cli_f');
    expect(cfg.appSecret).toBe('s');
  });

  it('rejects malformed E2E_VIDEO / E2E_SCREENSHOTS / E2E_TIMEOUT_MS', () => {
    expect(() => loadE2eConfig({ E2E_CHAT: 'B', E2E_VIDEO: 'gif' })).toThrow(
      /E2E_VIDEO must be off\|webm\|mp4/,
    );
    expect(() => loadE2eConfig({ E2E_CHAT: 'B', E2E_SCREENSHOTS: 'always' })).toThrow(
      /E2E_SCREENSHOTS must be off\|on\|failure/,
    );
    expect(() => loadE2eConfig({ E2E_CHAT: 'B', E2E_TIMEOUT_MS: 'abc' })).toThrow(
      /E2E_TIMEOUT_MS must be a positive number/,
    );
  });
});
