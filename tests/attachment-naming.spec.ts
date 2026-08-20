/**
 * Unit tests for inbound-attachment file naming: sanitization safety and
 * WeChat-style dedupe.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pickAttachmentFileName, sanitizeFileName } from '../src/attachment-naming.js';

describe('sanitizeFileName', () => {
  it('keeps a normal name intact', () => {
    expect(sanitizeFileName('report.pdf')).toBe('report.pdf');
  });

  it('preserves unicode (real file names are not ASCII)', () => {
    expect(sanitizeFileName('季度报告-中文.pdf')).toBe('季度报告-中文.pdf');
  });

  it('replaces path separators and traversal attempts', () => {
    expect(sanitizeFileName('../etc/passwd')).toBe('.._etc_passwd');
    expect(sanitizeFileName('a/b\\c')).toBe('a_b_c');
  });

  it('replaces Windows-reserved characters', () => {
    expect(sanitizeFileName('a<b>:c"d|e?f*g')).toBe('a_b_c_d_e_f_g');
  });

  it('strips control characters', () => {
    expect(sanitizeFileName('a\u0000b\u001fc.txt')).toBe('a_b_c.txt');
  });

  it('rejects empty or bare traversal names', () => {
    expect(sanitizeFileName('')).toBeUndefined();
    expect(sanitizeFileName('   ')).toBeUndefined();
    expect(sanitizeFileName('.')).toBeUndefined();
    expect(sanitizeFileName('..')).toBeUndefined();
  });

  it('caps very long names to a byte budget', () => {
    const long = 'x'.repeat(500);
    const result = sanitizeFileName(long);
    expect(result).toBeDefined();
    expect(Buffer.byteLength(result ?? '', 'utf8')).toBeLessThanOrEqual(200);
  });
});

describe('pickAttachmentFileName', () => {
  const existing = new Set<string>();
  const exists = (path: string): boolean => existing.has(path);

  it('uses the user name when free', () => {
    existing.clear();
    expect(pickAttachmentFileName('/dir', 'report.pdf', 'file_v3_key', 'pdf', exists)).toBe(
      'report.pdf',
    );
  });

  it('keeps the user extension and only sniffs when the name has none', () => {
    existing.clear();
    // Name carries its own extension: never `report.pdf.pdf`.
    expect(pickAttachmentFileName('/dir', 'report.pdf', 'k', 'pdf', exists)).toBe('report.pdf');
    // Name without an extension gets the sniffed one appended.
    expect(pickAttachmentFileName('/dir', 'report', 'k', 'pdf', exists)).toBe('report.pdf');
  });

  it('dedupes WeChat-style on collision', () => {
    existing.clear();
    existing.add(join('/dir', 'report.pdf'));
    expect(pickAttachmentFileName('/dir', 'report.pdf', 'k', 'pdf', exists)).toBe('report(1).pdf');
    existing.add(join('/dir', 'report(1).pdf'));
    expect(pickAttachmentFileName('/dir', 'report.pdf', 'k', 'pdf', exists)).toBe('report(2).pdf');
  });

  it('falls back to the key when the name is unusable', () => {
    existing.clear();
    expect(pickAttachmentFileName('/dir', '..', 'file_v3_key', 'pdf', exists)).toBe(
      'file_v3_key.pdf',
    );
    expect(pickAttachmentFileName('/dir', '', 'k_1', 'bin', exists)).toBe('k_1.bin');
  });

  it('falls back to the key and dedupes it too', () => {
    existing.clear();
    existing.add(join('/dir', 'k.pdf'));
    expect(pickAttachmentFileName('/dir', '', 'k', 'pdf', exists)).toBe('k(1).pdf');
  });
});
