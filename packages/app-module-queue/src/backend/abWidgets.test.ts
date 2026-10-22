import { describe, it, expect } from 'vitest';
import { loadAbWidget, sourcesRead, type Node } from './abWidget.js';

// The dashboard widgets under an A/B test of their layout. When a test is over, the winner goes back to being the plain view
// (and its file is no longer listed here).
const widgets = ['status-widget.yaml', 'activity-widget.yaml', 'outcomes-widget.yaml', 'relay-widget.yaml'];

describe.each(widgets)('%s A/B test', (file) => {
  const { doc, reference, variants } = loadAbWidget(file);

  it('names itself with an id the AbTest node accepts, and says what it tests', () => {
    expect(String(doc['id'])).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(typeof doc['label']).toBe('string');
    expect(reference).toBeDefined();
  });

  it('offers at least two layouts, each with a label and a hint', () => {
    const entries = Object.entries(variants);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const [name, variant] of entries) {
      expect(variant.label, name).toBeTruthy();
      expect(variant.hint, name).toBeTruthy();
    }
  });

  it('only reads sources the widget declares, in every layout (an undeclared one renders blank)', () => {
    const declared = new Set(Object.keys(doc['$sources'] as Node));
    for (const [name, variant] of Object.entries(variants)) {
      for (const source of sourcesRead(variant.view)) {
        expect(declared.has(source), `${name} reads $sources.${source}`).toBe(true);
      }
    }
  });

  // Dashboard columns are about 270 px wide: a layout of more than three tiles in one row wraps their labels
  it('puts at most three tiles in a row', () => {
    for (const [name, variant] of Object.entries(variants)) {
      const rows = JSON.stringify(variant.view).match(/"\$type":"HorizontalStack"[^]*?"items":\[([^]*?)\]\}/g) ?? [];
      for (const row of rows) {
        expect((row.match(/"\$type":"StatTile"/g) ?? []).length, name).toBeLessThanOrEqual(3);
      }
    }
  });
});
