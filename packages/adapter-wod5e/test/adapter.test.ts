import { describe, expect, it } from 'vitest';
import type { FoundryActorDoc, ResourceDescriptor, SheetSection } from '@companion/adapter-sdk';
import wod5eAdapterDefault, { wod5eAdapter } from '../src/index.js';
import vampireCapturedJson from './fixtures/vampire-captured.json' with { type: 'json' };

// The fixture is the relay's raw envelope ({type, data, requestId, uuid}) —
// the gateway hands the adapter the unwrapped `data` doc (see Task 0
// findings §"Feasibility gates" and the dnd5e captured-fixture tests for the
// same unwrap convention).
const marius = (vampireCapturedJson as { data: unknown }).data as FoundryActorDoc;

function resource(actor: FoundryActorDoc, id: string): ResourceDescriptor {
  const r = wod5eAdapter.resources(actor).find((d) => d.id === id);
  if (!r) throw new Error(`resource ${id} not found`);
  return r;
}

function section(actor: FoundryActorDoc, id: string): SheetSection {
  const s = wod5eAdapter.toViewModel(actor).sections.find((x) => x.id === id);
  if (!s) throw new Error(`section ${id} not found`);
  return s;
}

describe('exports', () => {
  it('exports the adapter as named and default export', () => {
    expect(wod5eAdapter.systemId).toBe('wod5e');
    expect(wod5eAdapterDefault).toBe(wod5eAdapter);
  });
});

describe('view model — identity, glyph, headline', () => {
  const vm = wod5eAdapter.toViewModel(marius);

  it('carries identity', () => {
    expect(vm.actorId).toBe('SGeXzzb4NApPhTJf');
    expect(vm.systemId).toBe('wod5e');
    expect(vm.name).toBe('Marius');
  });

  it('glyph is the ankh', () => {
    expect(vm.glyph).toBe('☥');
  });

  it('headline: no clan item on Marius -> Blood Potency + Hunger only', () => {
    expect(vm.headline.find((s) => s.id === 'clan')).toBeUndefined();
    const byId = new Map(vm.headline.map((s) => [s.id, s]));
    expect(byId.get('bloodpotency')?.value).toBe(1);
    expect(byId.get('hunger')?.value).toBe(2);
  });

  it('headline includes clan name when a clan-type item exists', () => {
    const withClan: FoundryActorDoc = {
      ...marius,
      items: [...(marius.items ?? []), { _id: 'clanItem01', name: 'Ventrue', type: 'clan', system: {} }],
    };
    const byId = new Map(wod5eAdapter.toViewModel(withClan).headline.map((s) => [s.id, s]));
    expect(byId.get('clan')?.value).toBe('Ventrue');
  });

  it('customItems: weapon (damage) and gear (no damage)', () => {
    expect(vm.customItems).toEqual([
      { type: 'weapon', label: 'Weapon', hasDamage: true },
      { type: 'gear', label: 'Gear', hasDamage: false },
    ]);
  });
});

describe('tabs', () => {
  const vm = wod5eAdapter.toViewModel(marius);

  it('exact tab shape', () => {
    expect(vm.tabs).toEqual([
      { id: 'overview', label: 'Overview', sectionIds: ['attributes', 'skills'], hostsActions: false },
      { id: 'rolls', label: 'Rolls', sectionIds: [], hostsActions: true },
      {
        id: 'disciplines',
        label: 'Disciplines',
        sectionIds: ['discipline-ratings', 'disciplines'],
        hostsActions: false,
      },
      { id: 'vitals', label: 'Vitals', sectionIds: ['tracks'], hostsActions: false },
      { id: 'gear', label: 'Gear', sectionIds: ['gear'], hostsActions: false },
    ]);
  });
});

const ALL_ATTRIBUTES = [
  'strength',
  'dexterity',
  'stamina',
  'charisma',
  'manipulation',
  'composure',
  'intelligence',
  'wits',
  'resolve',
];

describe('attributes section', () => {
  it('all 9 attributes as dots stats in vocab order, with fixture values and max 5, no actionId', () => {
    const s = section(marius, 'attributes');
    if (s.kind !== 'stats') throw new Error('attributes must be a stats section');
    // humanity is appended after the 9 attributes (see buildSections)
    expect(s.stats.map((x) => x.id).slice(0, 9)).toEqual(ALL_ATTRIBUTES.map((k) => `attr.${k}`));

    const expected: Record<string, number> = {
      strength: 3,
      dexterity: 2,
      stamina: 3,
      charisma: 2,
      manipulation: 3,
      composure: 2,
      intelligence: 2,
      wits: 3,
      resolve: 2,
    };
    for (const [key, value] of Object.entries(expected)) {
      const stat = s.stats.find((x) => x.id === `attr.${key}`);
      expect(stat, `attr.${key}`).toBeDefined();
      expect(stat?.value).toBe(value);
      expect(stat?.display).toBe('dots');
      expect(stat?.max).toBe(5);
      expect(stat?.actionId).toBeUndefined();
    }
  });

  it('includes humanity as a read-only dots stat (max 10)', () => {
    const s = section(marius, 'attributes');
    if (s.kind !== 'stats') throw new Error('attributes must be a stats section');
    const humanity = s.stats.find((x) => x.id === 'humanity');
    expect(humanity?.value).toBe(7);
    expect(humanity?.max).toBe(10);
    expect(humanity?.display).toBe('dots');
    expect(humanity?.actionId).toBeUndefined();
  });

  it('attribute default/min 1 when missing', () => {
    const sparse: FoundryActorDoc = { _id: 'x', name: 'Sparse', type: 'vampire', system: {} };
    const s = section(sparse, 'attributes');
    if (s.kind !== 'stats') throw new Error('attributes must be a stats section');
    expect(s.stats.find((x) => x.id === 'attr.strength')?.value).toBe(1);
  });
});

const ALL_SKILLS = [
  'academics',
  'animalken',
  'athletics',
  'awareness',
  'brawl',
  'craft',
  'drive',
  'etiquette',
  'finance',
  'firearms',
  'insight',
  'intimidation',
  'investigation',
  'larceny',
  'leadership',
  'medicine',
  'melee',
  'occult',
  'performance',
  'persuasion',
  'politics',
  'science',
  'stealth',
  'streetwise',
  'subterfuge',
  'survival',
  'technology',
];

describe('skills section', () => {
  it('renders all 27 canonical skills in vocab order, with fixture-raised values merged in place', () => {
    const s = section(marius, 'skills');
    if (s.kind !== 'stats') throw new Error('skills must be a stats section');
    expect(s.stats.map((x) => x.id)).toEqual(ALL_SKILLS.map((k) => `skill.${k}`));

    const occult = s.stats.find((x) => x.id === 'skill.occult');
    expect(occult?.value).toBe(3);
    expect(occult?.display).toBe('dots');
    expect(occult?.max).toBe(5);
    expect(occult?.actionId).toBeUndefined();

    const expected: Record<string, number> = {
      athletics: 1,
      brawl: 2,
      firearms: 2,
      occult: 3,
      persuasion: 2,
      streetwise: 1,
    };
    for (const [key, value] of Object.entries(expected)) {
      expect(s.stats.find((x) => x.id === `skill.${key}`)?.value).toBe(value);
    }
    // untouched skills default to 0
    expect(s.stats.find((x) => x.id === 'skill.academics')?.value).toBe(0);
    expect(s.stats.find((x) => x.id === 'skill.technology')?.value).toBe(0);
  });

  it('animalken label overrides to "Animal Ken"; a plain key falls back to capitalize()', () => {
    const s = section(marius, 'skills');
    if (s.kind !== 'stats') throw new Error('skills must be a stats section');
    expect(s.stats.find((x) => x.id === 'skill.animalken')?.label).toBe('Animal Ken');
    expect(s.stats.find((x) => x.id === 'skill.academics')?.label).toBe('Academics');
  });

  it('a homebrew skill key not in the vocab still renders, appended after the vocab entries', () => {
    const withHomebrew: FoundryActorDoc = {
      ...marius,
      system: {
        ...marius.system,
        skills: {
          ...(marius.system.skills as Record<string, unknown>),
          juggling: { value: 2 },
        },
      },
    };
    const s = wod5eAdapter.toViewModel(withHomebrew).sections.find((x) => x.id === 'skills');
    if (s?.kind !== 'stats') throw new Error('skills must be a stats section');
    const ids = s.stats.map((x) => x.id);
    expect(ids.indexOf('skill.juggling')).toBe(ALL_SKILLS.length);
    const juggling = s.stats.find((x) => x.id === 'skill.juggling');
    expect(juggling?.value).toBe(2);
    expect(juggling?.label).toBe('Juggling');
  });
});

describe('discipline-ratings section', () => {
  it('only potence and dominate (visible + value > 0 + has a power item)', () => {
    const s = section(marius, 'discipline-ratings');
    if (s.kind !== 'stats') throw new Error('discipline-ratings must be a stats section');
    expect(s.stats.map((x) => x.id).sort()).toEqual(['disc.dominate', 'disc.potence']);
    const potence = s.stats.find((x) => x.id === 'disc.potence');
    expect(potence?.value).toBe(2);
    expect(potence?.display).toBe('dots');
    expect(potence?.label).toBe('Potence');
    const dominate = s.stats.find((x) => x.id === 'disc.dominate');
    expect(dominate?.value).toBe(1);
    expect(dominate?.label).toBe('Dominate');
  });

  it('a discipline with a power item but visible:false/value 0 still appears (has-power rule)', () => {
    const withHiddenPower: FoundryActorDoc = {
      ...marius,
      system: {
        ...marius.system,
        disciplines: {
          ...(marius.system.disciplines as Record<string, unknown>),
          auspex: { value: 0, visible: false },
        },
      },
      items: [
        ...(marius.items ?? []),
        {
          _id: 'auspexPower01',
          name: 'Heightened Senses',
          type: 'power',
          system: { discipline: 'auspex', level: 1, cost: 0, description: '' },
        },
      ],
    };
    const s = wod5eAdapter
      .toViewModel(withHiddenPower)
      .sections.find((x) => x.id === 'discipline-ratings');
    if (s?.kind !== 'stats') throw new Error('discipline-ratings must be a stats section');
    expect(s.stats.find((x) => x.id === 'disc.auspex')).toBeDefined();
  });

  it('a discipline that is not visible, at 0, with no power item is excluded', () => {
    const withZeroDiscipline: FoundryActorDoc = {
      ...marius,
      system: {
        ...marius.system,
        disciplines: {
          ...(marius.system.disciplines as Record<string, unknown>),
          celerity: { value: 0, visible: false },
        },
      },
    };
    const s = wod5eAdapter
      .toViewModel(withZeroDiscipline)
      .sections.find((x) => x.id === 'discipline-ratings');
    if (s?.kind !== 'stats') throw new Error('discipline-ratings must be a stats section');
    expect(s.stats.find((x) => x.id === 'disc.celerity')).toBeUndefined();
  });
});

describe('disciplines (powers) list section', () => {
  it('groups Lethal Body under Potence', () => {
    const s = section(marius, 'disciplines');
    if (s.kind !== 'list') throw new Error('disciplines must be a list section');
    const lethalBody = s.items.find((i) => i.label === 'Lethal Body');
    expect(lethalBody).toBeDefined();
    expect(lethalBody?.sub).toBe('Level 1 · Potence');
    expect(lethalBody?.detail).toBe('Your bare hands deal aggravated damage to mortals.');
  });
});

describe('tracks section (boxTracks)', () => {
  it('exact boxTrack specs with fixture max values', () => {
    const s = section(marius, 'tracks');
    if (s.kind !== 'tracks') throw new Error('tracks must be a tracks section');
    expect(s.boxTracks).toEqual([
      { id: 'health', label: 'Health', max: 6, primaryId: 'health.superficial', aggravatedId: 'health.aggravated' },
      {
        id: 'willpower',
        label: 'Willpower',
        max: 4,
        primaryId: 'willpower.superficial',
        aggravatedId: 'willpower.aggravated',
      },
      { id: 'hunger', label: 'Hunger', max: 5, primaryId: 'hunger' },
      { id: 'stains', label: 'Stains', max: 10, primaryId: 'humanity.stains' },
    ]);
  });
});

describe('gear list section', () => {
  it('has Knife/Stake/Lockpicks; weapons carry Damage N · weaponType sub', () => {
    const s = section(marius, 'gear');
    if (s.kind !== 'list') throw new Error('gear must be a list section');
    expect(s.items.map((i) => i.label)).toEqual(['Knife', 'Lockpicks', 'Stake']);
    expect(s.items.find((i) => i.label === 'Knife')?.sub).toBe('Damage 2 · melee');
    expect(s.items.find((i) => i.label === 'Stake')?.sub).toBe('Damage 2 · melee');
  });

  it('gear item quantity links a resource only when > 1', () => {
    const s = section(marius, 'gear');
    if (s.kind !== 'list') throw new Error('gear must be a list section');
    expect(s.items.find((i) => i.label === 'Lockpicks')?.resourceId).toBeUndefined();

    const stacked: FoundryActorDoc = {
      ...marius,
      items: (marius.items ?? []).map((i) =>
        i.name === 'Lockpicks' ? { ...i, system: { ...i.system, quantity: 5 } } : i,
      ),
    };
    const s2 = wod5eAdapter.toViewModel(stacked).sections.find((x) => x.id === 'gear');
    if (s2?.kind !== 'list') throw new Error('gear must be a list section');
    const lockpicks = s2.items.find((i) => i.label === 'Lockpicks');
    expect(lockpicks?.resourceId).toBe(`item.${(marius.items ?? []).find((i) => i.name === 'Lockpicks')?._id}.qty`);
  });
});

describe('resources — exact ids and dynamic bounds', () => {
  it('health boxes: max = health.max - the other box (Marius: max 6, sup 1, agg 1)', () => {
    expect(resource(marius, 'health.superficial')).toMatchObject({ value: 1, min: 0, max: 5, writable: true });
    expect(resource(marius, 'health.aggravated')).toMatchObject({ value: 1, min: 0, max: 5, writable: true });
  });

  it('willpower boxes: max 4, sup 1, agg 0', () => {
    expect(resource(marius, 'willpower.superficial')).toMatchObject({ value: 1, min: 0, max: 4, writable: true });
    expect(resource(marius, 'willpower.aggravated')).toMatchObject({ value: 0, min: 0, max: 3, writable: true });
  });

  it('hunger: 0..5, value 2', () => {
    expect(resource(marius, 'hunger')).toMatchObject({ value: 2, min: 0, max: 5, writable: true });
  });

  it('humanity.stains: 0..10, value 1', () => {
    expect(resource(marius, 'humanity.stains')).toMatchObject({ value: 1, min: 0, max: 10, writable: true });
  });

  it('read-only humanity and bloodpotency are present', () => {
    expect(resource(marius, 'humanity')).toMatchObject({ value: 7, writable: false });
    expect(resource(marius, 'bloodpotency')).toMatchObject({ value: 1, writable: false });
  });

  it('embeds the resource descriptors on the view model', () => {
    expect(wod5eAdapter.toViewModel(marius).resources).toEqual(wod5eAdapter.resources(marius));
  });
});

describe('sparse-actor safety', () => {
  const sparse: FoundryActorDoc = { _id: 'sparse01', name: 'Empty', type: 'vampire', system: {} };

  it('toViewModel and resources do not throw on an empty system', () => {
    expect(() => wod5eAdapter.toViewModel(sparse)).not.toThrow();
    expect(() => wod5eAdapter.resources(sparse)).not.toThrow();
  });

  it('defensive defaults: all 9 attributes at 1, all 27 skills at 0, disciplines/gear empty, boxes at 0', () => {
    const vm = wod5eAdapter.toViewModel(sparse);
    const attrs = vm.sections.find((s) => s.id === 'attributes');
    if (attrs?.kind !== 'stats') throw new Error('attributes must be a stats section');
    expect(attrs.stats.find((s) => s.id === 'attr.strength')?.value).toBe(1);
    // 9 attributes + humanity, all at default
    expect(attrs.stats.slice(0, 9).map((s) => s.id)).toEqual(ALL_ATTRIBUTES.map((k) => `attr.${k}`));
    expect(attrs.stats.slice(0, 9).every((s) => s.value === 1)).toBe(true);

    const skills = vm.sections.find((s) => s.id === 'skills');
    if (skills?.kind !== 'stats') throw new Error('skills must be a stats section');
    expect(skills.stats.map((s) => s.id)).toEqual(ALL_SKILLS.map((k) => `skill.${k}`));
    expect(skills.stats.every((s) => s.value === 0)).toBe(true);

    const ratings = vm.sections.find((s) => s.id === 'discipline-ratings');
    if (ratings?.kind !== 'stats') throw new Error('discipline-ratings must be a stats section');
    expect(ratings.stats).toEqual([]);

    const disciplines = vm.sections.find((s) => s.id === 'disciplines');
    if (disciplines?.kind !== 'list') throw new Error('disciplines must be a list section');
    expect(disciplines.items).toEqual([]);

    const gear = vm.sections.find((s) => s.id === 'gear');
    if (gear?.kind !== 'list') throw new Error('gear must be a list section');
    expect(gear.items).toEqual([]);

    const tracks = vm.sections.find((s) => s.id === 'tracks');
    if (tracks?.kind !== 'tracks') throw new Error('tracks must be a tracks section');
    expect(tracks.boxTracks).toEqual([
      { id: 'health', label: 'Health', max: 0, primaryId: 'health.superficial', aggravatedId: 'health.aggravated' },
      {
        id: 'willpower',
        label: 'Willpower',
        max: 0,
        primaryId: 'willpower.superficial',
        aggravatedId: 'willpower.aggravated',
      },
      { id: 'hunger', label: 'Hunger', max: 5, primaryId: 'hunger' },
      { id: 'stains', label: 'Stains', max: 10, primaryId: 'humanity.stains' },
    ]);
  });

  it('resources on the sparse actor do not throw and clamp bounds at 0', () => {
    const resources = wod5eAdapter.resources(sparse);
    expect(resources.find((r) => r.id === 'health.superficial')).toMatchObject({ value: 0, max: 0 });
    expect(resources.find((r) => r.id === 'humanity')?.value).toBe(7);
    expect(resources.find((r) => r.id === 'bloodpotency')?.value).toBe(0);
  });
});
