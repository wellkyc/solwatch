import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSolanaAddress } from '../server/base58';
import { parseTransaction, SOL_MINT } from '../server/parser';
import type { RawTx } from '../server/types';

const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const OTHER = 'FeePayer1111111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function tx(overrides: Partial<RawTx>): RawTx {
  return {
    signature: 'sig',
    blockTime: 1_700_000_000,
    fee: 5000,
    err: false,
    accountKeys: [OTHER, WALLET],
    preBalances: [10_000_000_000, 1_000_000_000],
    postBalances: [10_000_000_000, 1_000_000_000],
    preTokenBalances: [],
    postTokenBalances: [],
    ...overrides,
  };
}

describe('parseTransaction', () => {
  it('detects an incoming SOL transfer', () => {
    const event = parseTransaction(tx({ postBalances: [7_499_995_000, 3_500_000_000] }), WALLET);
    assert.equal(event.kind, 'receive');
    assert.deepEqual(event.changes, [{ mint: SOL_MINT, symbol: 'SOL', amount: 2.5 }]);
    assert.equal(event.time, 1_700_000_000_000);
    assert.equal(event.feePayer, false);
    assert.equal(event.fee, 0);
  });

  it('excludes the network fee from an outgoing transfer by the fee payer', () => {
    const event = parseTransaction(
      tx({
        accountKeys: [WALLET, OTHER],
        preBalances: [5_000_000_000, 0],
        postBalances: [3_999_995_000, 1_000_000_000],
      }),
      WALLET,
    );
    assert.equal(event.kind, 'send');
    assert.deepEqual(event.changes, [{ mint: SOL_MINT, symbol: 'SOL', amount: -1 }]);
    assert.equal(event.feePayer, true);
    assert.equal(event.fee, 0.000005);
  });

  it('detects a SOL to USDC swap', () => {
    const event = parseTransaction(
      tx({
        accountKeys: [WALLET, OTHER],
        preBalances: [5_000_000_000, 0],
        postBalances: [3_999_995_000, 0],
        preTokenBalances: [{ mint: USDC, owner: WALLET, amount: '10' }],
        postTokenBalances: [{ mint: USDC, owner: WALLET, amount: '160.5' }],
      }),
      WALLET,
    );
    assert.equal(event.kind, 'swap');
    assert.deepEqual(
      event.changes.map((c) => [c.symbol, c.amount]),
      [
        ['SOL', -1],
        ['USDC', 150.5],
      ],
    );
  });

  it('merges wrapped SOL into native SOL', () => {
    const event = parseTransaction(
      tx({
        accountKeys: [WALLET, OTHER],
        preBalances: [5_000_000_000, 0],
        postBalances: [3_999_995_000, 1_000_000_000],
        postTokenBalances: [{ mint: SOL_MINT, owner: WALLET, amount: '1' }],
      }),
      WALLET,
    );
    assert.equal(event.kind, 'other');
    assert.deepEqual(event.changes, []);
  });

  it('ignores token balances owned by other wallets', () => {
    const event = parseTransaction(
      tx({
        preTokenBalances: [{ mint: USDC, owner: OTHER, amount: '100' }],
        postTokenBalances: [{ mint: USDC, owner: OTHER, amount: '0' }],
      }),
      WALLET,
    );
    assert.equal(event.kind, 'other');
  });

  it('marks failed transactions', () => {
    const event = parseTransaction(tx({ err: true, postBalances: [9_999_995_000, 1_000_000_000] }), WALLET);
    assert.equal(event.kind, 'failed');
    assert.deepEqual(event.changes, []);
  });

  it('labels unknown tokens with a shortened mint', () => {
    const mint = 'Mint111111111111111111111111111111111111111';
    const event = parseTransaction(tx({ postTokenBalances: [{ mint, owner: WALLET, amount: '42' }] }), WALLET);
    assert.equal(event.changes[0].symbol, 'Mint...1111');
  });

  it('uses the current time when the block time is missing', () => {
    const event = parseTransaction(tx({ blockTime: null }), WALLET, 123);
    assert.equal(event.time, 123);
  });
});

describe('isSolanaAddress', () => {
  it('accepts valid addresses', () => {
    assert.equal(isSolanaAddress(WALLET), true);
    assert.equal(isSolanaAddress(USDC), true);
    assert.equal(isSolanaAddress('11111111111111111111111111111111'), true);
  });

  it('rejects invalid input', () => {
    assert.equal(isSolanaAddress(''), false);
    assert.equal(isSolanaAddress('hello'), false);
    assert.equal(isSolanaAddress('0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'), false);
    assert.equal(isSolanaAddress(`${WALLET}x`), false);
  });
});
