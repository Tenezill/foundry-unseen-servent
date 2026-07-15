import { describe, expect, it } from 'vitest';
import { renderStatusHtml } from '../src/status-page.js';
import type { BootstrapStatus } from '../src/status.js';

function status(phase: BootstrapStatus['phase'], detail = 'd'): BootstrapStatus {
  return { phase, detail, error: null, updatedAt: '2026-07-15T12:00:00Z' };
}

describe('renderStatusHtml', () => {
  it('renders phase, guidance, and detail', () => {
    const html = renderStatusHtml(status('waiting-world'));
    expect(html).toContain('waiting-world');
    expect(html).toContain('create your world'); // guidance text
  });

  it('escapes detail/error content (no HTML injection from the volume)', () => {
    const html = renderStatusHtml({
      phase: 'error',
      detail: '<script>alert(1)</script>',
      error: { class: 'X<Y', message: 'a&b' },
      updatedAt: 'x',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('needs-pairing renders the guided one-time pairing instructions', () => {
    const html = renderStatusHtml(status('needs-pairing'));
    expect(html).toContain('Pair');
    expect(html).toContain('/pair/');
  });
});
