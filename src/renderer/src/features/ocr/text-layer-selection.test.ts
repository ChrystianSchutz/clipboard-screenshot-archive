/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { positionFromDom } from './text-layer-selection';

/** The DOM shape `TextLayer` renders: lines with `data-line`, pieces with `data-start`. */
function buildLayer(): HTMLElement {
  const layer = document.createElement('div');
  layer.innerHTML = [
    '<div data-line="0"><span data-start="0">Hello</span><span data-start="5"> </span><span data-start="6">world</span></div>',
    '<div data-line="1"><span data-start="0">Bye</span></div>',
  ].join('');
  document.body.replaceChildren(layer);
  return layer;
}

const piece = (layer: HTMLElement, line: number, start: number) =>
  layer.querySelector<HTMLElement>(`[data-line="${line}"] [data-start="${start}"]`)!;

describe('positionFromDom', () => {
  let layer: HTMLElement;
  beforeEach(() => {
    layer = buildLayer();
  });

  it('maps an offset inside a word to the offset in its line', () => {
    const world = piece(layer, 0, 6).firstChild!;
    expect(positionFromDom(world, 3)).toEqual({ line: 0, offset: 9 });
  });

  it('clamps an offset past the end of a text node', () => {
    expect(positionFromDom(piece(layer, 1, 0).firstChild!, 99)).toEqual({ line: 1, offset: 3 });
  });

  it('maps the span itself to before or after its text', () => {
    const world = piece(layer, 0, 6);
    expect(positionFromDom(world, 0)).toEqual({ line: 0, offset: 6 });
    expect(positionFromDom(world, 1)).toEqual({ line: 0, offset: 11 });
  });

  it('maps "child N of a line" to the start of that piece, or the line end', () => {
    const line = layer.querySelector('[data-line="0"]')!;
    expect(positionFromDom(line, 2)).toEqual({ line: 0, offset: 6 });
    expect(positionFromDom(line, 3)).toEqual({ line: 0, offset: 11 });
  });

  it('maps "child N of the layer" to the start of line N, or past the last line', () => {
    expect(positionFromDom(layer, 1)).toEqual({ line: 1, offset: 0 });
    expect(positionFromDom(layer, 2)).toEqual({ line: 1, offset: Number.MAX_SAFE_INTEGER });
  });

  it('gives up outside a layer', () => {
    const stray = document.createElement('p');
    document.body.append(stray);
    expect(positionFromDom(stray, 0)).toBeNull();
  });
});
