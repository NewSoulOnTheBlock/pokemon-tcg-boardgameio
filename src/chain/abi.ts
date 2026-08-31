// Hand-rolled ABI encoding for the two ERC-20 calls the browser makes.
//
// Deliberately dependency-free. The client only ever needs `balanceOf` and
// `transfer`, both of which have well-known 4-byte selectors and take only
// static (32-byte) arguments — so a full ABI coder would be ~120 KB of
// bundle for about forty lines of work. The server does the heavy lifting
// (event decoding, NFT minting) with ethers, where bundle size is free.
//
// See src/chain/config.ts for why keeping the client bundle small matters
// to this app in particular.

/** ERC-20 `balanceOf(address)`. */
export const SELECTOR_BALANCE_OF = '0x70a08231';
/** ERC-20 `transfer(address,uint256)`. */
export const SELECTOR_TRANSFER = '0xa9059cbb';
/** keccak256('Transfer(address,address,uint256)') — topic0 on every
 *  ERC-20 and ERC-721 transfer log. */
export const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function stripHex(value: string): string {
  return value.startsWith('0x') || value.startsWith('0X') ? value.slice(2) : value;
}

/** Left-pad a hex string to a 32-byte ABI word. */
export function padWord(hex: string): string {
  const clean = stripHex(hex).toLowerCase();
  if (clean.length > 64) {
    throw new Error(`ABI word overflow: ${hex}`);
  }
  return clean.padStart(64, '0');
}

export function encodeAddress(address: string): string {
  const clean = stripHex(address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Not a valid EVM address: ${address}`);
  }
  return padWord(clean);
}

export function encodeUint256(value: bigint): string {
  if (value < 0n) {
    throw new Error(`uint256 cannot be negative: ${value}`);
  }
  return padWord(value.toString(16));
}

/** Calldata for `balanceOf(owner)`. */
export function encodeBalanceOf(owner: string): string {
  return `${SELECTOR_BALANCE_OF}${encodeAddress(owner)}`;
}

/** Calldata for `transfer(to, amount)`. */
export function encodeTransfer(to: string, amount: bigint): string {
  return `${SELECTOR_TRANSFER}${encodeAddress(to)}${encodeUint256(amount)}`;
}

/** Decode a 32-byte return word (or a longer return blob's first word)
 *  into a bigint. Returns 0n for the empty response an `eth_call` gives
 *  when the target address holds no code. */
export function decodeUint256(hex: string | null | undefined): bigint {
  const clean = stripHex(hex ?? '');
  if (!clean) return 0n;
  return BigInt(`0x${clean.slice(0, 64)}`);
}

/** Decode an address from a 32-byte log topic (left-padded). */
export function decodeAddressTopic(topic: string): string {
  return `0x${stripHex(topic).slice(-40).toLowerCase()}`;
}

/** Scale a whole-token amount to raw units. Uses string maths rather than
 *  floating point so 18-decimal amounts survive without precision loss. */
export function toRawUnits(whole: number | string, decimals: number): bigint {
  const text = typeof whole === 'number' ? whole.toString() : whole.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`Not a positive decimal amount: ${whole}`);
  }
  const [intPart, fracPart = ''] = text.split('.');
  const frac = fracPart.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(intPart + (decimals > 0 ? frac : ''));
}

/** Raw units back to a JS number of whole tokens. Safe for display; the
 *  supply of an 18-decimal token stays well inside float range once
 *  divided down. */
export function fromRawUnits(raw: bigint, decimals: number): number {
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const remainder = raw % divisor;
  return Number(whole) + Number(remainder) / Number(divisor);
}
