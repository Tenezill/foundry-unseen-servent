/**
 * Feature 3 — initiative & skill/ability total fidelity. enrich folds the
 * relay's derived totals (which the plain /get omits) so feats/active effects
 * (e.g. Temporal Awareness adding INT to initiative) are reflected.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dnd5eAdapter } from '../src/index.js';
import type { FoundryActorDoc } from '@companion/adapter-sdk';

function fixture(name: string): FoundryActorDoc {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as FoundryActorDoc;
}
const martialCaptured = fixture('martial-captured.json');

async function enrichWith(actor: FoundryActorDoc, response: unknown, calls?: string[][]) {
  if (!dnd5eAdapter.enrich) throw new Error('adapter must expose enrich()');
  return dnd5eAdapter.enrich(actor, {
    getSystemDetails: async (details) => {
      calls?.push(details);
      return response;
    },
  });
}

/**
 * Read a stat's `value` from the built sheet. The init/ac/prof stats live in
 * the top-level `headline` array; skills/saves live in `sections` by id. Pass
 * sectionId 'headline' for the former.
 */
function statValue(actor: FoundryActorDoc, sectionId: string, statId: string): string | number | undefined {
  const sheet = dnd5eAdapter.toViewModel(actor) as {
    headline?: Array<{ id: string; value: string | number }>;
    sections: Array<{ id: string; stats?: Array<{ id: string; value: string | number }> }>;
  };
  const pools =
    sectionId === 'headline'
      ? [sheet.headline ?? []]
      : sheet.sections.filter((s) => s.id === sectionId).map((s) => s.stats ?? []);
  for (const stats of pools) {
    const found = stats.find((s) => s.id === statId);
    if (found) return found.value;
  }
  return undefined;
}

describe('enrich — derived initiative', () => {
  it('folds stats.initBonus into attributes.init.total and the init card', async () => {
    const enriched = await enrichWith(martialCaptured, { stats: { initBonus: 5 } });
    const sys = enriched.system as { attributes: { init: { total: unknown } } };
    expect(sys.attributes.init.total).toBe(5);
    expect(statValue(enriched, 'headline', 'init')).toBe('+5');
  });

  it('requests skills and abilities alongside stats (caster: spells too)', async () => {
    const calls: string[][] = [];
    await enrichWith(martialCaptured, { stats: {} }, calls);
    expect(calls).toEqual([['spells', 'stats', 'skills', 'abilities']]);
  });

  it('ignores non-numeric initBonus (local fallback stands)', async () => {
    for (const initBonus of [null, 'x', Number.NaN]) {
      const enriched = await enrichWith(martialCaptured, { stats: { initBonus } });
      const sys = enriched.system as { attributes: { init: { total?: unknown } } };
      expect(sys.attributes.init.total).toBeUndefined();
    }
  });
});

describe('enrich — derived skill totals', () => {
  it('folds skills.<id>.total so the skill card shows the derived bonus', async () => {
    const enriched = await enrichWith(martialCaptured, {
      stats: {},
      skills: { ath: { total: 7, mod: 7, passive: 17 } },
    });
    const sys = enriched.system as { skills: Record<string, { total?: unknown }> };
    expect(sys.skills.ath?.total).toBe(7);
    expect(statValue(enriched, 'skills', 'skill.ath')).toBe('+7');
  });

  it('leaves untouched skills alone and ignores non-numeric totals', async () => {
    const enriched = await enrichWith(martialCaptured, {
      stats: {},
      skills: { acr: { total: 'x' } },
    });
    const sys = enriched.system as { skills: Record<string, { total?: unknown }> };
    expect(sys.skills.acr?.total).not.toBe('x');
  });
});

describe('enrich — derived ability mods + saves', () => {
  it('folds abilities.<id>.mod and .save (flattened number) into source shape', async () => {
    const enriched = await enrichWith(martialCaptured, {
      stats: {},
      abilities: { str: { mod: 3, save: 5 } },
    });
    const sys = enriched.system as {
      abilities: Record<string, { mod?: unknown; save?: { value?: unknown } }>;
    };
    expect(sys.abilities.str?.mod).toBe(3);
    expect(sys.abilities.str?.save?.value).toBe(5);
    // saveBonus (via the Saving Throws card) reflects the derived save value
    expect(statValue(enriched, 'saves', 'save.str')).toBe('+5');
  });

  it('ignores non-numeric mod/save', async () => {
    const enriched = await enrichWith(martialCaptured, {
      stats: {},
      abilities: { dex: { mod: 'x', save: null } },
    });
    const sys = enriched.system as { abilities: Record<string, { mod?: unknown }> };
    expect(sys.abilities.dex?.mod).not.toBe('x');
  });
});
