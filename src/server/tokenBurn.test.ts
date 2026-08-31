// The burn verifier is the only thing standing between a forged HTTP
// request and free cards, so every rejection path gets a test.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getReceipt = vi.fn();
vi.mock('./evmRpc', () => ({
  getReceipt: (...args: unknown[]) => getReceipt(...args),
}));

const { DEAD_ADDRESS, POKETCG_TOKEN_ADDRESS } = await import('../chain/config');
const { TOPIC_TRANSFER } = await import('../chain/abi');
const { PoketcgBurnError, POKETCG_PACK_TIERS, findPoketcgTier, rawCostForTier, verifyPoketcgBurn } =
  await import('./tokenBurn');

const BUYER = '0x000000000000000000000000000000000000beef';
const TX = `0x${'a'.repeat(64)}`;
const OTHER_TOKEN = '0x9999999999999999999999999999999999999999';

function topicFor(address: string): string {
  return `0x${address.replace(/^0x/, '').padStart(64, '0')}`;
}

function amountData(whole: number): string {
  return `0x${(BigInt(whole) * 10n ** 18n).toString(16).padStart(64, '0')}`;
}

function transferLog(overrides: Partial<{ address: string; from: string; to: string; whole: number }> = {}) {
  const { address = POKETCG_TOKEN_ADDRESS, from = BUYER, to = DEAD_ADDRESS, whole = 100_000 } = overrides;
  return {
    address,
    topics: [TOPIC_TRANSFER, topicFor(from), topicFor(to)],
    data: amountData(whole),
    blockNumber: '0x1',
    transactionHash: TX,
    logIndex: '0x0',
  };
}

function receipt(logs: ReturnType<typeof transferLog>[], overrides: Partial<{ status: string; from: string }> = {}) {
  return {
    transactionHash: TX,
    status: overrides.status ?? '0x1',
    blockNumber: '0x1',
    from: overrides.from ?? BUYER,
    to: POKETCG_TOKEN_ADDRESS,
    logs,
  };
}

const onePack = rawCostForTier(findPoketcgTier(1)!);

beforeEach(() => {
  getReceipt.mockReset();
});

describe('pack tiers', () => {
  it('discounts the bulk tiers relative to a single pack', () => {
    const single = POKETCG_PACK_TIERS[0]!;
    for (const tier of POKETCG_PACK_TIERS.slice(1)) {
      expect(tier.costTokens / tier.packs).toBeLessThan(single.costTokens / single.packs);
    }
  });

  it('scales a tier cost to 18-decimal raw units', () => {
    expect(rawCostForTier({ packs: 1, costTokens: 100_000 })).toBe(100_000n * 10n ** 18n);
  });
});

describe('verifyPoketcgBurn', () => {
  it('accepts a well-formed burn and reports the amount', async () => {
    getReceipt.mockResolvedValue(receipt([transferLog()]));

    const result = await verifyPoketcgBurn({ txHash: TX, buyerWallet: BUYER, minRawAmount: onePack });

    expect(result.rawAmount).toBe(onePack);
    expect(result.uiAmount).toBe(100_000);
  });

  it('sums multiple burn transfers in one transaction', async () => {
    getReceipt.mockResolvedValue(receipt([
      transferLog({ whole: 60_000 }),
      transferLog({ whole: 40_000 }),
    ]));

    const result = await verifyPoketcgBurn({ txHash: TX, buyerWallet: BUYER, minRawAmount: onePack });
    expect(result.uiAmount).toBe(100_000);
  });

  it('matches the buyer case-insensitively', async () => {
    getReceipt.mockResolvedValue(receipt([transferLog()]));
    await expect(
      verifyPoketcgBurn({ txHash: TX, buyerWallet: BUYER.toUpperCase().replace('0X', '0x'), minRawAmount: onePack }),
    ).resolves.toBeTruthy();
  });

  it('rejects a transaction that has not landed yet', async () => {
    getReceipt.mockResolvedValue(null);
    await expect(verifyPoketcgBurn({ txHash: TX, buyerWallet: BUYER, minRawAmount: onePack }))
      .rejects.toMatchObject({ name: 'PoketcgBurnError', status: 400 });
  });

  it('rejects a reverted transaction', async () => {
    getReceipt.mockResolvedValue(receipt([transferLog()], { status: '0x0' }));
    await expect(verifyPoketcgBurn({ txHash: TX, buyerWallet: BUYER, minRawAmount: onePack }))
      .rejects.toThrow(/reverted/);
  });

  // Someone else's burn is still a real burn — but it isn't this player's.
  it('rejects a burn sent by a different wallet', async () => {
    getReceipt.mockResolvedValue(receipt([transferLog()], { from: '0x00000000000000000000000000000000000000ff' }));
    await expect(verifyPoketcgBurn({ txHash: TX, buyerWallet: BUYER, minRawAmount: onePack }))
      .rejects.toMatchObject({ status: 403 });
  });

  it('ignores transfers of a different token', async () => {
    getReceipt.mockResolvedValue(receipt([transferLog({ address: OTHER_TOKEN })]));
    await expect(verifyPoketcgBurn({ txHash: TX, buyerWallet: BUYER, minRawAmount: onePack }))
      .rejects.toMatchObject({ status: 402 });
  });

  // The whole point of the burn: a transfer to a wallet you control is not
  // a burn, so paying yourself must not buy packs.
  it('ignores a transfer that is not to the burn address', async () => {
    getReceipt.mockResolvedValue(receipt([transferLog({ to: BUYER })]));
    await expect(verifyPoketcgBurn({ txHash: TX, buyerWallet: BUYER, minRawAmount: onePack }))
      .rejects.toMatchObject({ status: 402 });
  });

  it('ignores a burn authored by someone other than the buyer', async () => {
    getReceipt.mockResolvedValue(receipt([transferLog({ from: OTHER_TOKEN })]));
    await expect(verifyPoketcgBurn({ txHash: TX, buyerWallet: BUYER, minRawAmount: onePack }))
      .rejects.toMatchObject({ status: 402 });
  });

  it('ignores non-Transfer logs on the token contract', async () => {
    const log = transferLog();
    log.topics = [`0x${'b'.repeat(64)}`, log.topics[1], log.topics[2]];
    getReceipt.mockResolvedValue(receipt([log]));
    await expect(verifyPoketcgBurn({ txHash: TX, buyerWallet: BUYER, minRawAmount: onePack }))
      .rejects.toMatchObject({ status: 402 });
  });

  // Claiming the 7-pack tier while burning the 1-pack amount is the
  // cheapest possible exploit; it has to cost the full tier price.
  it('rejects a burn below the claimed tier cost', async () => {
    getReceipt.mockResolvedValue(receipt([transferLog({ whole: 100_000 })]));
    const sevenPack = rawCostForTier(findPoketcgTier(7)!);
    await expect(verifyPoketcgBurn({ txHash: TX, buyerWallet: BUYER, minRawAmount: sevenPack }))
      .rejects.toMatchObject({ status: 402 });
  });

  it('accepts an overpayment', async () => {
    getReceipt.mockResolvedValue(receipt([transferLog({ whole: 999_999 })]));
    await expect(verifyPoketcgBurn({ txHash: TX, buyerWallet: BUYER, minRawAmount: onePack }))
      .resolves.toMatchObject({ uiAmount: 999_999 });
  });

  it('exports PoketcgBurnError so the route can map it to a status', () => {
    expect(new PoketcgBurnError(402, 'nope').status).toBe(402);
  });
});
