/**
 * Feature: passive advantage/disadvantage indicators on d20 rows. Display-only
 * bias derived from dnd5e flags, equipped stealth-disadvantage armor, and the
 * per-roll `roll.mode` override — attached to skill/check/save Stats.
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

type BiasStat = { id: string; advantage?: boolean; disadvantage?: boolean };

/** Pull a stat from a stats section of the built sheet. */
function stat(actor: FoundryActorDoc, sectionId: string, statId: string): BiasStat | undefined {
  const sheet = dnd5eAdapter.toViewModel(actor) as {
    sections: Array<{ id: string; stats?: BiasStat[] }>;
  };
  return sheet.sections.find((s) => s.id === sectionId)?.stats?.find((s) => s.id === statId);
}

/** Graft dnd5e flags onto the capture (preserving its existing dnd5e flags). */
function withFlags(actor: FoundryActorDoc, dnd5e: Record<string, unknown>): FoundryActorDoc {
  const prev = (actor.flags as { dnd5e?: Record<string, unknown> })?.dnd5e ?? {};
  return { ...actor, flags: { ...(actor.flags as object), dnd5e: { ...prev, ...dnd5e } } };
}

describe('roll bias — equipped stealth-disadvantage armor', () => {
  it('flags Stealth as disadvantage when heavy armor is equipped (real capture)', () => {
    // martial-captured has Chain Mail equipped with properties ['stealthDisadvantage'].
    const ste = stat(martialCaptured, 'skills', 'skill.ste');
    expect(ste?.disadvantage).toBe(true);
    expect(ste?.advantage).toBeUndefined();
  });

  it('leaves an unaffected skill with neither field', () => {
    const acr = stat(martialCaptured, 'skills', 'skill.acr');
    expect(acr?.advantage).toBeUndefined();
    expect(acr?.disadvantage).toBeUndefined();
  });
});

describe('roll bias — dnd5e flags', () => {
  it('advantage.skill.<id> sets advantage on that skill', () => {
    const actor = withFlags(martialCaptured, { advantage: { skill: { acr: 1 } } });
    expect(stat(actor, 'skills', 'skill.acr')?.advantage).toBe(true);
  });

  it('disadvantage.ability.save.<id> sets disadvantage on that save', () => {
    const actor = withFlags(martialCaptured, { disadvantage: { ability: { save: { wis: '1' } } } });
    expect(stat(actor, 'saves', 'save.wis')?.disadvantage).toBe(true);
  });

  it('advantage.ability.check.<id> sets advantage on that ability check (gem)', () => {
    const actor = withFlags(martialCaptured, { advantage: { ability: { check: { int: true } } } });
    expect(stat(actor, 'abilities', 'ability.int')?.advantage).toBe(true);
  });

  it('advantage.all sets advantage across a skill, a save, and an ability check', () => {
    const actor = withFlags(martialCaptured, { advantage: { all: 1 } });
    expect(stat(actor, 'skills', 'skill.arc')?.advantage).toBe(true);
    expect(stat(actor, 'saves', 'save.str')?.advantage).toBe(true);
    expect(stat(actor, 'abilities', 'ability.cha')?.advantage).toBe(true);
  });

  it('shows BOTH badges when an advantage flag and armor-disadvantage collide on Stealth', () => {
    const actor = withFlags(martialCaptured, { advantage: { skill: { ste: 1 } } });
    const ste = stat(actor, 'skills', 'skill.ste');
    expect(ste?.advantage).toBe(true);
    expect(ste?.disadvantage).toBe(true);
  });
});

describe('roll bias — per-roll mode override', () => {
  it('skills.<id>.roll.mode === 1 sets advantage', () => {
    const sys = martialCaptured.system as { skills: Record<string, { roll?: { mode?: number } }> };
    const actor: FoundryActorDoc = {
      ...martialCaptured,
      system: {
        ...martialCaptured.system,
        skills: { ...sys.skills, acr: { ...sys.skills.acr, roll: { mode: 1 } } },
      },
    };
    expect(stat(actor, 'skills', 'skill.acr')?.advantage).toBe(true);
  });
});
