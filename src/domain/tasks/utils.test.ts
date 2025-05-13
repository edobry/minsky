import { describe, expect, test } from 'bun:test';
import { normalizeTaskId } from './utils';

describe('normalizeTaskId', () => {
  const testCases = [
    { input: '#064', expected: '#064', note: 'with # and leading zero' },
    { input: '#64', expected: '#64', note: 'with #, no leading zero' },
    { input: '064', expected: '#064', note: 'no #, with leading zero' },
    { input: '64', expected: '#64', note: 'no #, no leading zero' },
    { input: 'task#064', expected: '#064', note: 'with task# and leading zero' },
    { input: 'task#64', expected: '#64', note: 'with task#, no leading zero' },
    { input: 'TASK#64', expected: '#64', note: 'with TASK# (uppercase), no leading zero' },
    { input: '  #64  ', expected: '#64', note: 'with whitespace' },
    { input: 'task#0', expected: '#0', note: 'task ID zero' },
    { input: '0', expected: '#0', note: 'task ID zero numeric' },
  ];

  for (const { input, expected, note } of testCases) {
    test(`should normalize "${input}" to "${expected}" (${note})`, () => {
      expect(normalizeTaskId(input)).toBe(expected);
    });
  }

  test('should return null for invalid inputs', () => {
    const invalidInputs = [
      { input: 'abc', note: 'non-numeric' },
      { input: '#abc', note: '# with non-numeric' },
      { input: 'task#abc', note: 'task# with non-numeric' },
      { input: '64a', note: 'numeric followed by alpha' },
      { input: 'a64', note: 'alpha followed by numeric' },
      { input: '#', note: 'only #' },
      { input: 'task#', note: 'only task#' },
      { input: '', note: 'empty string' },
      { input: '   ', note: 'whitespace only' },
      { input: null, note: 'null input' },
      { input: undefined, note: 'undefined input' },
      { input: 123, note: 'number input type' },
    ];

    for (const { input, note } of invalidInputs) {
      test(`should return null for invalid input "${input}" (${note})`, () => {
        expect(normalizeTaskId(input as any)).toBeNull();
      });
    }
  });
}); 
