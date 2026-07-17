import { describe, expect, it } from 'vitest';
import {
  buildUpdateSteps,
  hasDestructiveStep,
  DESTRUCTIVE_TOKENS,
} from '../../../scripts/update-stack.mjs';

const compose = ['docker', 'compose'];

describe('buildUpdateSteps', () => {
  it('NEVER emits a state-nuking token (the core "don\'t reset my setup" guarantee)', () => {
    const steps = buildUpdateSteps(compose, { pull: true });
    expect(hasDestructiveStep(steps)).toBe(false);
    for (const s of steps) {
      for (const t of DESTRUCTIVE_TOKENS) expect(s.cmd).not.toContain(t);
    }
  });

  it('does exactly: pull code → pull images → rebuild & restart', () => {
    const steps = buildUpdateSteps(compose, { pull: true });
    expect(steps.map((s) => s.cmd.join(' '))).toEqual([
      'git pull --ff-only',
      'docker compose pull',
      'docker compose up -d --build',
    ]);
  });

  it('--no-pull skips the git step and keeps the two compose steps', () => {
    const steps = buildUpdateSteps(compose, { pull: false });
    expect(steps.some((s) => s.cmd[0] === 'git')).toBe(false);
    expect(steps).toHaveLength(2);
    expect(hasDestructiveStep(steps)).toBe(false);
  });

  it('hasDestructiveStep catches a destructive plan (down -v)', () => {
    expect(hasDestructiveStep([{ label: 'x', cwd: '.', cmd: ['docker', 'compose', 'down', '-v'] }])).toBe(true);
  });
});
