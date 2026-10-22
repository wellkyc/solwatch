import type { AssetChange, EventKind, RawTx, WalletEvent } from './types';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000;

const EPSILON = 1e-9;

const KNOWN_TOKENS: Record<string, string> = {
  [SOL_MINT]: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
};

export function symbolFor(mint: string): string {
  return KNOWN_TOKENS[mint] ?? `${mint.slice(0, 4)}...${mint.slice(-4)}`;
}

function collectDeltas(tx: RawTx, wallet: string): Map<string, number> {
  const deltas = new Map<string, number>();
  const add = (mint: string, value: number) => deltas.set(mint, (deltas.get(mint) ?? 0) + value);

  for (const balance of tx.preTokenBalances) {
    if (balance.owner === wallet) add(balance.mint, -Number(balance.amount));
  }
  for (const balance of tx.postTokenBalances) {
    if (balance.owner === wallet) add(balance.mint, Number(balance.amount));
  }

  const index = tx.accountKeys.indexOf(wallet);
  if (index >= 0) {
    let lamports = (tx.postBalances[index] ?? 0) - (tx.preBalances[index] ?? 0);
    if (index === 0) lamports += tx.fee;
    add(SOL_MINT, lamports / LAMPORTS_PER_SOL);
  }

  return deltas;
}

function classify(changes: AssetChange[], failed: boolean): EventKind {
  if (failed) return 'failed';
  const hasIn = changes.some((c) => c.amount > 0);
  const hasOut = changes.some((c) => c.amount < 0);
  if (hasIn && hasOut) return 'swap';
  if (hasIn) return 'receive';
  if (hasOut) return 'send';
  return 'other';
}

export function parseTransaction(tx: RawTx, wallet: string, now = Date.now()): WalletEvent {
  const changes: AssetChange[] = [];
  if (!tx.err) {
    for (const [mint, amount] of collectDeltas(tx, wallet)) {
      if (Math.abs(amount) > EPSILON) changes.push({ mint, symbol: symbolFor(mint), amount });
    }
    changes.sort((a, b) => a.amount - b.amount);
  }

  const feePayer = tx.accountKeys[0] === wallet;

  return {
    id: `${tx.signature}:${wallet}`,
    signature: tx.signature,
    wallet,
    time: tx.blockTime ? tx.blockTime * 1000 : now,
    kind: classify(changes, tx.err),
    changes,
    fee: feePayer ? tx.fee / LAMPORTS_PER_SOL : 0,
    feePayer,
  };
}
