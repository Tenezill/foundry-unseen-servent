/**
 * Foundry text-enricher resolution: descriptions must render human labels, not
 * raw tokens like "&Reference[inv]{Investigation}" (seen on "Warder's
 * Intuition"). Conservative — only recognized shapes are rewritten.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dnd5eAdapter, resolveEnrichers } from '../src/index.js';
import type { FoundryActorDoc } from '@companion/adapter-sdk';

describe('resolveEnrichers', () => {
  it('resolves a labeled &Reference to its label (the Warder\'s Intuition bug)', () => {
    expect(resolveEnrichers('Make an Intelligence (&Reference[inv]{Investigation}) check.')).toBe(
      'Make an Intelligence (Investigation) check.',
    );
  });

  it('resolves labeled @UUID / @Check to their labels', () => {
    expect(resolveEnrichers('Cast @UUID[Compendium.dnd5e.spells.abc]{Fireball} now')).toBe('Cast Fireball now');
    expect(resolveEnrichers('Roll @Check[ability=dex;dc=15]{a DC 15 Dexterity check}')).toBe(
      'Roll a DC 15 Dexterity check',
    );
  });

  it('resolves inline rolls: labeled to label, bare to formula', () => {
    expect(resolveEnrichers('Heal [[/r 2d4 + 2]]{2d4 + 2} HP')).toBe('Heal 2d4 + 2 HP');
    expect(resolveEnrichers('Deal [[/r 1d6]] damage')).toBe('Deal 1d6 damage');
  });

  it('preserves surrounding HTML tags', () => {
    expect(resolveEnrichers('<p>A (&Reference[inv]{Investigation}) check.</p>')).toBe(
      '<p>A (Investigation) check.</p>',
    );
  });

  it('leaves unknown/labelless tokens untouched (no mangling)', () => {
    expect(resolveEnrichers('@Check[ability=dex;dc=15] and plain text')).toBe('@Check[ability=dex;dc=15] and plain text');
    expect(resolveEnrichers('no tokens here')).toBe('no tokens here');
  });
});

describe('enricher resolution through the view model', () => {
  it('a feat description renders the enricher label in its detail', () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/martial-captured.json', import.meta.url));
    const base = JSON.parse(readFileSync(fixturePath, 'utf8')) as FoundryActorDoc;
    const actor: FoundryActorDoc = {
      ...base,
      items: [
        {
          _id: 'featWI',
          type: 'feat',
          name: "Warder's Intuition",
          system: {
            description: { value: '<p>When you make an Intelligence (&Reference[inv]{Investigation}) check…</p>' },
          },
        } as unknown as FoundryActorDoc['items'] extends (infer T)[] ? T : never,
      ],
    };
    const sheet = dnd5eAdapter.toViewModel(actor) as {
      sections: Array<{ id: string; items?: Array<{ id: string; detail?: string }> }>;
    };
    const features = sheet.sections.find((s) => s.id === 'features');
    const detail = features?.items?.find((i) => i.id === 'featWI')?.detail ?? '';
    expect(detail).toContain('(Investigation)');
    expect(detail).not.toContain('&Reference');
  });
});
