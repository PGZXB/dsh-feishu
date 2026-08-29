/**
 * Unit tests for the portable-deployment packager (`scripts/package-portable.mjs`).
 * The heavy, network-bound path (node download + `npm install` of the DSH
 * anchor) is verified end-to-end by `buildPortablePackage` / the `--dump-config`
 * smoke test in the PR body; here we cover the deterministic, offline parts
 * (the shipped launcher/doc files and the module surface).
 */

import { describe, expect, it } from 'vitest';
import {
  bootstrapFiles,
  buildBundle,
  buildPortablePackage,
  installBundleRuntimeDeps,
  installDshAnchor,
  main,
  provideNode,
  resolveNodeVersion,
  writeTemplateHome,
} from '../scripts/package-portable.mjs';

describe('package-portable', () => {
  it('exposes the expected build/verify surface', () => {
    expect(typeof main).toBe('function');
    expect(typeof buildPortablePackage).toBe('function');
    expect(typeof buildBundle).toBe('function');
    expect(typeof provideNode).toBe('function');
    expect(typeof installDshAnchor).toBe('function');
    expect(typeof installBundleRuntimeDeps).toBe('function');
    expect(typeof writeTemplateHome).toBe('function');
    expect(typeof resolveNodeVersion).toBe('function');
  });

  it('ships every per-instance launcher and the deployment readme', () => {
    const files = bootstrapFiles();
    for (const rel of [
      'bin/dsh-feishu',
      'bin/start',
      'bin/setup',
      'bin/init-instance',
      'instance.env.example',
      'README-PORTABLE.md',
    ]) {
      expect(Object.hasOwn(files, rel)).toBe(true);
      expect((files[rel] ?? '').length).toBeGreaterThan(0);
    }
  });

  it('setup launcher runs the bundle quick-setup wizard against the instance home', () => {
    const setup = bootstrapFiles()['bin/setup'];
    expect(setup).toContain('--profile feishu');
    expect(setup).toContain('--dsh-home "$DSH_HOME"');
    expect(setup).toContain('bundle/dsh-feishu/lib/setup/cli.js');
    expect(setup).toContain('DSH_FEISHU_SESSION');
  });

  it('launcher boots the bundled dsh entry and binds the instance home', () => {
    const launcher = bootstrapFiles()['bin/dsh-feishu'];
    expect(launcher).toContain('--profile feishu');
    expect(launcher).toContain('export DSH_HOME="${DSH_HOME:-$ROOT/home}"');
    expect(launcher).toContain('instance.env');
    expect(launcher).toContain('runtime/node/bin');
    expect(launcher).toContain('runtime/app/node_modules/@deepseek-ai/dsh/lib/bin.js');
  });

  it('instance.env example carries the per-instance credentials and unsets the proxy', () => {
    const env = bootstrapFiles()['instance.env.example'];
    for (const key of ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'DEEPSEEK_API_KEY']) {
      expect(env).toContain(key);
    }
    expect(env).toContain('unset http_proxy https_proxy');
  });
});
