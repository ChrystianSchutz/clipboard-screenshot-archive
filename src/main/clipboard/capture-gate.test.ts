import { describe, expect, it } from 'vitest';
import { CaptureGate } from './capture-gate';

describe('CaptureGate', () => {
  it('keeps a generation current until the gate is invalidated', () => {
    const gate = new CaptureGate();
    const taken = gate.current;

    expect(gate.isCurrent(taken)).toBe(true);
    gate.invalidate();
    expect(gate.isCurrent(taken)).toBe(false);
    expect(gate.isCurrent(gate.current)).toBe(true);
  });

  it('never makes an old generation current again (pause then resume)', () => {
    const gate = new CaptureGate();
    const taken = gate.current;

    gate.invalidate();
    gate.invalidate();

    expect(gate.isCurrent(taken)).toBe(false);
  });
});

describe('CaptureGate.close', () => {
  it('never lets any generation commit again, not even one taken after the close', () => {
    const gate = new CaptureGate();
    const before = gate.current;

    gate.close();
    const after = gate.current;
    gate.invalidate();

    expect(gate.isClosed).toBe(true);
    expect(gate.isCurrent(before)).toBe(false);
    expect(gate.isCurrent(after)).toBe(false);
    expect(gate.isCurrent(gate.current)).toBe(false);
  });
});
