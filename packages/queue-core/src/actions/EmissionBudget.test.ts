import { describe, it, expect } from 'vitest';
import { EmissionBudget, MAX_ACTION_EMISSIONS_PER_ROOT } from './EmissionBudget.js';

describe('EmissionBudget', () => {
  it('exports the per-root cap', () => {
    expect(MAX_ACTION_EMISSIONS_PER_ROOT).toBe(100);
  });

  it('grants the cap per root and refuses the next one, without touching another root', () => {
    const budget = new EmissionBudget({ maxPerRoot: 3 });
    expect([1, 2, 3].map(() => budget.reserve('root-a').granted)).toEqual([true, true, true]);
    expect(budget.reserve('root-a')).toEqual({ granted: false, count: 3, firstRefusal: true });
    // the diagnostic is said once per root
    expect(budget.reserve('root-a')).toEqual({ granted: false, count: 3, firstRefusal: false });
    expect(budget.reserve('root-b').granted).toBe(true);
  });

  it('a released reservation (the push was refused) gives its slot back', () => {
    const budget = new EmissionBudget({ maxPerRoot: 1 });
    expect(budget.reserve('r').granted).toBe(true);
    budget.release('r');
    expect(budget.reserve('r').granted).toBe(true);
    expect(budget.reserve('r').granted).toBe(false);
  });

  it('forgets a root idle for longer than the time to live', () => {
    let now = 0;
    const budget = new EmissionBudget({ maxPerRoot: 1, ttlMs: 1000, now: () => now });
    budget.reserve('old');
    now = 1001;
    budget.reserve('new');
    expect(budget.size).toBe(1);
    // a forgotten root starts again
    expect(budget.reserve('old').granted).toBe(true);
  });

  it('never tracks more roots than the bound: the oldest are dropped', () => {
    const budget = new EmissionBudget({ maxRoots: 10 });
    for (let i = 0; i < 1000; i++) {
      budget.reserve(`root-${i}`);
    }
    expect(budget.size).toBeLessThanOrEqual(10);
  });

  it('the default bound is 10000 roots and one hour', () => {
    const budget = new EmissionBudget();
    for (let i = 0; i < 10_050; i++) {
      budget.reserve(`root-${i}`);
    }
    expect(budget.size).toBe(10_000);
  });
});
