import { describe, expect, it } from 'vitest';
import {
  denormalize,
  describe as describeRecord,
  mapMirageRecord,
  type MirageRecordContext,
} from './mirage-record';

const CONTEXT: MirageRecordContext = {
  engine: 'mirage-test',
  language: 'en',
  width: 800,
  height: 600,
  durationMs: 42,
};

/** A record as Mirage writes it for a photo of a wine bottle with a label. */
const WINE_RECORD = {
  scene: { setting: 'indoor' },
  objects: [
    {
      id: 1,
      name: 'wine bottle',
      bbox: [157, 43, 355, 786],
      score: 0.442,
      position: 'left',
      description: { color: 'green' },
    },
  ],
  text: [{ string: 'aptak', bbox: [214, 441, 296, 473], score: 0.553 }],
  reasoning: 'lang: en | wine bottle, wine glass | glasses hold beverages',
};

function objectWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { name: 'cup', bbox: [0, 0, 500, 500], ...overrides };
}

describe('mapMirageRecord', () => {
  it('maps a full record onto the original image', () => {
    expect(mapMirageRecord(WINE_RECORD, CONTEXT)).toEqual({
      engine: 'mirage-test',
      language: 'en',
      width: 800,
      height: 600,
      description: ['wine bottle, wine glass', 'glasses hold beverages'],
      scene: { setting: 'indoor' },
      objects: [
        {
          id: 1,
          label: 'wine bottle',
          // 157/1000 × 800 = 125.6 → 125, 43/1000 × 600 = 25.8 → 25, 355 → 284, 786/1000 × 600 = 471.6 → 472
          box: { x0: 125, y0: 25, x1: 284, y1: 472 },
          score: 0.442,
          position: 'left',
          attributes: { color: 'green' },
        },
      ],
      text: [{ text: 'aptak', box: { x0: 171, y0: 264, x1: 237, y1: 284 }, score: 0.553 }],
      durationMs: 42,
    });
  });

  it('describes the scene as "key: value" lines when there is no reasoning', () => {
    const analysis = mapMirageRecord(
      { scene: { setting: 'indoor', time_of_day: 'night', lighting: 42 } },
      CONTEXT,
    );

    expect(analysis.description).toEqual(['setting: indoor', 'time of day: night']);
    expect(analysis.scene).toEqual({ setting: 'indoor', time_of_day: 'night' });
  });

  it('accepts an empty record', () => {
    expect(mapMirageRecord({}, CONTEXT)).toMatchObject({
      description: [],
      scene: {},
      objects: [],
      text: [],
    });
  });

  it('drops malformed objects and text lines but keeps the rest', () => {
    const analysis = mapMirageRecord(
      {
        objects: [
          'not an object',
          objectWith({ name: '' }),
          objectWith({ bbox: [1, 2, 3] }),
          objectWith({ id: 1.5 }),
          objectWith({ name: 'kept', id: 7 }),
        ],
        text: [
          { string: '', bbox: [0, 0, 1, 1] },
          { string: 'no box' },
          null,
          { string: 'kept', bbox: [0, 0, 100, 100] },
        ],
      },
      CONTEXT,
    );

    expect(analysis.objects.map((object) => object.label)).toEqual(['kept']);
    expect(analysis.text.map((line) => line.text)).toEqual(['kept']);
  });

  it('numbers objects without an id by their position in the list', () => {
    const analysis = mapMirageRecord(
      { objects: [objectWith({ id: 9 }), objectWith({}), objectWith({})] },
      CONTEXT,
    );
    expect(analysis.objects.map((object) => object.id)).toEqual([9, 2, 3]);
  });

  it('keeps only non-empty string attributes, trimmed', () => {
    const analysis = mapMirageRecord(
      {
        objects: [
          objectWith({
            description: { color: ' red ', count: 3, shiny: true, material: '  ', label: null },
          }),
        ],
      },
      CONTEXT,
    );
    expect(analysis.objects[0]!.attributes).toEqual({ color: 'red' });
  });

  it('clamps scores to 0..1, rounds them to three decimals and defaults a missing one to 0', () => {
    const analysis = mapMirageRecord(
      {
        objects: [
          objectWith({ score: 1.7 }),
          objectWith({ score: -0.2 }),
          objectWith({ score: 0.12345 }),
          objectWith({}),
        ],
        text: [{ string: 'x', bbox: [0, 0, 1, 1] }],
      },
      CONTEXT,
    );

    expect(analysis.objects.map((object) => object.score)).toEqual([1, 0, 0.123, 0]);
    expect(analysis.text[0]!.score).toBe(0);
  });

  it('trims labels and positions, and leaves out a blank position', () => {
    const analysis = mapMirageRecord(
      {
        objects: [
          objectWith({ name: '  cup ', position: ' on table ' }),
          objectWith({ position: '   ' }),
        ],
      },
      CONTEXT,
    );

    expect(analysis.objects[0]).toMatchObject({ label: 'cup', position: 'on table' });
    expect(analysis.objects[1]).not.toHaveProperty('position');
  });

  it('rejects a record that is not an object', () => {
    for (const raw of [null, 'text', 42, [], { objects: 'none' }]) {
      expect(() => mapMirageRecord(raw, CONTEXT)).toThrow(
        'Image analysis returned an unexpected result',
      );
    }
  });
});

describe('describe', () => {
  it('splits the reasoning trace into statements without the language tag', () => {
    expect(describeRecord('LANG : pl | butelka wina |  | kieliszek', {})).toEqual([
      'butelka wina',
      'kieliszek',
    ]);
  });

  it('prefers the reasoning over the scene', () => {
    expect(describeRecord('a cat', { setting: 'indoor' })).toEqual(['a cat']);
  });

  it('falls back to the scene when the trace holds only the language tag', () => {
    expect(describeRecord('lang: en', { art_style: 'flat' })).toEqual(['art style: flat']);
  });
});

describe('denormalize', () => {
  it('grows the box outwards to whole pixels', () => {
    expect(denormalize([1, 1, 999, 999], 333, 333)).toEqual({ x0: 0, y0: 0, x1: 333, y1: 333 });
    expect(denormalize([500, 250, 750, 1000], 100, 200)).toEqual({
      x0: 50,
      y0: 50,
      x1: 75,
      y1: 200,
    });
  });

  it('orders swapped corners', () => {
    expect(denormalize([750, 1000, 500, 250], 100, 200)).toEqual({
      x0: 50,
      y0: 50,
      x1: 75,
      y1: 200,
    });
  });

  it('clamps coordinates outside the image', () => {
    expect(denormalize([-50, -10, 1200, 1001], 100, 200)).toEqual({
      x0: 0,
      y0: 0,
      x1: 100,
      y1: 200,
    });
  });
});
