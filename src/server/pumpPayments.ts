// Server-side wrapper around @pump-fun/agent-payments-sdk's PumpAgent.
//
// Booster pack flow:
//   1. Client asks for an invoice -> we generate (memo, startTime, endTime)
//      and build the unsigned base64 Transaction here.
//   2. Client signs and submits the transaction with their wallet adapter.
//   3. Client POSTs back with the same (memo, startTime, endTime) plus the
//      pack details. We call validateInvoicePayment which checks against
//      pump.fun's HTTP API + on-chain RPC fallback. Only after success do
//      we roll pack contents, mint NFTs, and persist the purchase.
//
// The invoice ID PDA is deterministic from (mint, currencyMint, amount,
// memo, startTime, endTime), so the same invoice can only be paid once
// on-chain. Memo is random to avoid collisions.

import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { PumpAgent } from '@pump-fun/agent-payments-sdk';

export interface PumpPaymentConfig {
  agentMintAddress: string;
  currencyMintAddress: string;
  amountSmallestUnit: number;
  rpcUrl: string;
  /** Seconds. Defaults to 24h. */
  invoiceLifetimeSeconds?: number;
}

export interface BuiltInvoice {
  memo: string;
  startTime: string;
  endTime: string;
  amount: string;
  transactionBase64: string;
  agentMint: string;
  currencyMint: string;
}

export interface VerifyInvoiceParams {
  walletAddress: string;
  memo: string;
  startTime: string;
  endTime: string;
}

export interface PumpPaymentService {
  buildInvoice(walletAddress: string): Promise<BuiltInvoice>;
  verifyInvoice(params: VerifyInvoiceParams): Promise<boolean>;
  readonly amount: number;
  readonly currencyMint: PublicKey;
  readonly agentMint: PublicKey;
}

const DEFAULT_INVOICE_LIFETIME = 24 * 60 * 60;
// Each verification retry waits a bit so the HTTP indexer / RPC catches
// up with the just-confirmed transaction. Matches the skill's recommended
// 10 attempts at 2s for ~20s of slack.
const VERIFY_RETRIES = 10;
const VERIFY_BACKOFF_MS = 2_000;

export function createPumpPaymentService(config: PumpPaymentConfig): PumpPaymentService {
  if (!(config.amountSmallestUnit > 0)) {
    throw new Error('PumpPaymentConfig.amountSmallestUnit must be > 0');
  }
  const agentMint = new PublicKey(config.agentMintAddress);
  const currencyMint = new PublicKey(config.currencyMintAddress);
  const connection = new Connection(config.rpcUrl, 'confirmed');
  const agent = new PumpAgent(agentMint, 'mainnet', connection);
  const amount = config.amountSmallestUnit;
  const lifetime = config.invoiceLifetimeSeconds ?? DEFAULT_INVOICE_LIFETIME;

  async function buildInvoice(walletAddress: string): Promise<BuiltInvoice> {
    const user = new PublicKey(walletAddress);
    const now = Math.floor(Date.now() / 1000);
    const startTime = now;
    const endTime = now + lifetime;
    // Pump.fun's invoice memo is a uint64; we keep it in a safe int range
    // and stringify everywhere to dodge BigInt JSON serialisation issues.
    const memo = Math.floor(Math.random() * 900_000_000_000) + 100_000;

    const instructions = await agent.buildAcceptPaymentInstructions({
      user,
      currencyMint,
      amount: String(amount),
      memo: String(memo),
      startTime: String(startTime),
      endTime: String(endTime),
    });

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = user;
    tx.add(...instructions);

    const transactionBase64 = tx
      .serialize({ requireAllSignatures: false })
      .toString('base64');

    return {
      memo: String(memo),
      startTime: String(startTime),
      endTime: String(endTime),
      amount: String(amount),
      transactionBase64,
      agentMint: agentMint.toBase58(),
      currencyMint: currencyMint.toBase58(),
    };
  }

  async function verifyInvoice({
    walletAddress,
    memo,
    startTime,
    endTime,
  }: VerifyInvoiceParams): Promise<boolean> {
    const user = new PublicKey(walletAddress);
    const memoNum = Number(memo);
    const startNum = Number(startTime);
    const endNum = Number(endTime);
    if (!Number.isFinite(memoNum) || !Number.isFinite(startNum) || !Number.isFinite(endNum)) {
      throw new Error('memo, startTime, and endTime must be numeric strings');
    }

    for (let attempt = 0; attempt < VERIFY_RETRIES; attempt += 1) {
      try {
        const ok = await agent.validateInvoicePayment({
          user,
          currencyMint,
          amount,
          memo: memoNum,
          startTime: startNum,
          endTime: endNum,
        });
        if (ok) return true;
      } catch (err) {
        // Network blip on the pump.fun HTTP API; the SDK will fall back to
        // RPC log scanning on the next iteration when Connection is set.
        console.warn(`[pump-payments] verify attempt ${attempt + 1} threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (attempt < VERIFY_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, VERIFY_BACKOFF_MS));
      }
    }
    return false;
  }

  return {
    buildInvoice,
    verifyInvoice,
    amount,
    currencyMint,
    agentMint,
  };
}
