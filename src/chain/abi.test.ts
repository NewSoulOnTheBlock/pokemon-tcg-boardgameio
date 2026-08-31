import { describe, expect, it } from 'vitest';
import {
  SELECTOR_BALANCE_OF,
  SELECTOR_TRANSFER,
  decodeAddressTopic,
  decodeUint256,
  encodeBalanceOf,
  encodeTransfer,
  fromRawUnits,
  toRawUnits,
} from './abi';

const ADDR = '0xAbC0000000000000000000000000000000000123';

describe('encodeBalanceOf', () => {
  it('produces selector + one left-padded address word', () => {
    const data = encodeBalanceOf(ADDR);
    expect(data.startsWith(SELECTOR_BALANCE_OF)).toBe(true);
    // 4-byte selector (10 chars with 0x) + exactly one 32-byte word.
    expect(data).toHaveLength(10 + 64);
    expect(data.endsWith('abc0000000000000000000000000000000000123')).toBe(true);
  });

  it('rejects anything that is not a 20-byte address', () => {
    expect(() => encodeBalanceOf('0x123')).toThrow(/valid EVM address/);
  });
});

describe('encodeTransfer', () => {
  it('produces selector + address word + amount word', () => {
    const data = encodeTransfer(ADDR, 1n);
    expect(data.startsWith(SELECTOR_TRANSFER)).toBe(true);
    expect(data).toHaveLength(10 + 128);
    expect(data.slice(-64)).toBe('0'.repeat(63) + '1');
  });

  it('encodes an 18-decimal amount that overflows a JS number', () => {
    // 100 000 whole tokens at 18 decimals = 1e23, past MAX_SAFE_INTEGER.
    const amount = toRawUnits(100_000, 18);
    expect(amount).toBe(100_000_000_000_000_000_000_000n);
    expect(decodeUint256(encodeTransfer(ADDR, amount).slice(-64))).toBe(amount);
  });

  it('refuses a negative amount', () => {
    expect(() => encodeTransfer(ADDR, -1n)).toThrow(/cannot be negative/);
  });
});

describe('decodeUint256', () => {
  it('reads the first word of a return blob', () => {
    expect(decodeUint256(`0x${'0'.repeat(62)}ff`)).toBe(255n);
  });

  it('treats an empty eth_call result as zero', () => {
    // eth_call against an address with no code returns '0x'.
    expect(decodeUint256('0x')).toBe(0n);
    expect(decodeUint256(null)).toBe(0n);
    expect(decodeUint256(undefined)).toBe(0n);
  });
});

describe('decodeAddressTopic', () => {
  it('takes the low 20 bytes of a log topic and lowercases them', () => {
    expect(decodeAddressTopic(`0x${'0'.repeat(24)}ABC0000000000000000000000000000000000123`))
      .toBe('0xabc0000000000000000000000000000000000123');
  });
});

describe('toRawUnits', () => {
  it('scales whole tokens without floating-point drift', () => {
    expect(toRawUnits(1, 18)).toBe(10n ** 18n);
    expect(toRawUnits(250_000, 18)).toBe(250_000n * 10n ** 18n);
  });

  it('accepts fractional amounts and truncates past the decimal count', () => {
    expect(toRawUnits('1.5', 18)).toBe(1_500_000_000_000_000_000n);
    expect(toRawUnits('1.23456789', 4)).toBe(12_345n);
  });

  it('rejects non-numeric or negative input', () => {
    expect(() => toRawUnits('-1', 18)).toThrow(/positive decimal/);
    expect(() => toRawUnits('abc', 18)).toThrow(/positive decimal/);
  });
});

describe('fromRawUnits', () => {
  it('round-trips a whole-token amount', () => {
    expect(fromRawUnits(toRawUnits(500_000, 18), 18)).toBe(500_000);
  });

  it('keeps a fractional balance readable', () => {
    expect(fromRawUnits(1_500_000_000_000_000_000n, 18)).toBeCloseTo(1.5, 10);
  });
});
