import { describe, expect, it } from 'vitest';
import { formatThirdPartyLicenses } from '../../../scripts/generate-third-party-licenses.mjs';

describe('formatThirdPartyLicenses', () => {
  const fixture = {
    MIT: [
      { name: 'zod', versions: ['3.24.1'], homepage: 'https://zod.dev' },
      { name: 'h3', versions: ['1.13.0'] },
    ],
    'Apache-2.0': [{ name: 'fuse.js', versions: ['7.0.0'] }],
  };

  it('renders one section per license with each package listed', () => {
    const md = formatThirdPartyLicenses(fixture);
    expect(md).toContain('# Third-party licenses');
    expect(md).toContain('## MIT');
    expect(md).toContain('## Apache-2.0');
    expect(md).toContain('- zod (3.24.1) — https://zod.dev');
    expect(md).toContain('- h3 (1.13.0)');
    expect(md).toContain('- fuse.js (7.0.0)');
  });

  it('sorts license sections alphabetically (stable output = clean git diffs)', () => {
    const md = formatThirdPartyLicenses(fixture);
    expect(md.indexOf('## Apache-2.0')).toBeLessThan(md.indexOf('## MIT'));
  });
});
