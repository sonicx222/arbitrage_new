import { describe, it, expect } from 'vitest';
import { toCsv } from './export';

describe('toCsv', () => {
  it('generates CSV with headers and rows', () => {
    const csv = toCsv(['Name', 'Age'], [['Alice', 30], ['Bob', 25]]);
    expect(csv).toBe('Name,Age\nAlice,30\nBob,25');
  });

  it('escapes commas in values', () => {
    const csv = toCsv(['Desc'], [['hello, world']]);
    expect(csv).toBe('Desc\n"hello, world"');
  });

  it('escapes double quotes in values', () => {
    const csv = toCsv(['Desc'], [['say "hi"']]);
    expect(csv).toBe('Desc\n"say ""hi"""');
  });

  it('escapes newlines in values', () => {
    const csv = toCsv(['Desc'], [['line1\nline2']]);
    expect(csv).toBe('Desc\n"line1\nline2"');
  });

  it('handles null and undefined values', () => {
    const csv = toCsv(['A', 'B'], [[null, undefined]]);
    expect(csv).toBe('A,B\n,');
  });

  it('handles empty rows', () => {
    const csv = toCsv(['A', 'B'], []);
    expect(csv).toBe('A,B');
  });

  it('converts numbers to strings', () => {
    const csv = toCsv(['Price'], [[42.5]]);
    expect(csv).toBe('Price\n42.5');
  });

  it('handles mixed types in a row', () => {
    const csv = toCsv(['Time', 'Chain', 'Profit'], [['12:00:00', 'ethereum', 1.23]]);
    expect(csv).toBe('Time,Chain,Profit\n12:00:00,ethereum,1.23');
  });

  it('prevents CSV formula injection by prefixing dangerous chars with tab', () => {
    const csv = toCsv(['Msg'], [['=cmd|/C calc|'], ['+1'], ['-1'], ['@SUM(A1:A2)']]);
    // Tab-prefixed values containing tab must be quoted
    expect(csv).toContain('"\t=cmd|/C calc|"');
    expect(csv).toContain('"\t+1"');
    expect(csv).toContain('"\t-1"');
    expect(csv).toContain('"\t@SUM(A1:A2)"');
  });
});
