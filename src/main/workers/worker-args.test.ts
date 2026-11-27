import { describe, expect, it } from 'vitest';
import { workerArgument } from './worker-args';

describe('workerArgument', () => {
  const argv = [
    'C:\\app\\electron.exe',
    'out/main/ocr-host.js',
    '--tessdata=C:\\models\\tessdata',
    '--lang=eng+pol',
  ];

  it('reads the value of a --name=value argument', () => {
    expect(workerArgument(argv, 'tessdata')).toBe('C:\\models\\tessdata');
    expect(workerArgument(argv, 'lang')).toBe('eng+pol');
  });

  it('keeps everything after the first "=", including further "=" signs', () => {
    expect(workerArgument(['--query=a=b'], 'query')).toBe('a=b');
  });

  it('does not confuse an argument with a longer one sharing its prefix', () => {
    expect(workerArgument(['--model-dir=C:\\models', '--model=tiny.onnx'], 'model')).toBe(
      'tiny.onnx',
    );
  });

  it('uses the first occurrence when an argument is repeated', () => {
    expect(workerArgument(['--lang=eng', '--lang=pol'], 'lang')).toBe('eng');
  });

  it('throws when the argument is missing', () => {
    expect(() => workerArgument(argv, 'model')).toThrow('Worker started without --model=');
  });

  it('throws when the argument is present but empty', () => {
    expect(() => workerArgument(['--model='], 'model')).toThrow('Worker started without --model=');
  });
});
