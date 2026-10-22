import type { RawTokenBalance, RawTx } from './types';

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

interface ParsedTokenBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: { uiAmountString?: string };
}

interface ParsedTransaction {
  blockTime: number | null;
  transaction: { message: { accountKeys: { pubkey: string }[] } };
  meta: {
    fee: number;
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: ParsedTokenBalance[];
    postTokenBalances?: ParsedTokenBalance[];
  } | null;
}

export interface SignatureInfo {
  signature: string;
  blockTime: number | null;
  err: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RpcClient {
  private nextId = 1;

  constructor(private readonly url: string, private readonly retries = 5) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      });

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= this.retries) throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}`);

      const body = (await response.json()) as RpcResponse<T>;
      if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
      return body.result as T;
    }
  }

  async getBalance(address: string): Promise<number> {
    const result = await this.call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
    return result.value;
  }

  getSignatures(address: string, limit: number): Promise<SignatureInfo[]> {
    return this.call('getSignaturesForAddress', [address, { limit, commitment: 'confirmed' }]);
  }

  async getTransaction(signature: string): Promise<RawTx | null> {
    const tx = await this.call<ParsedTransaction | null>('getTransaction', [
      signature,
      { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 },
    ]);
    if (!tx?.meta) return null;

    const toRaw = (b: ParsedTokenBalance): RawTokenBalance => ({
      mint: b.mint,
      owner: b.owner,
      amount: b.uiTokenAmount.uiAmountString ?? '0',
    });

    return {
      signature,
      blockTime: tx.blockTime,
      fee: tx.meta.fee,
      err: tx.meta.err !== null,
      accountKeys: tx.transaction.message.accountKeys.map((k) => k.pubkey),
      preBalances: tx.meta.preBalances,
      postBalances: tx.meta.postBalances,
      preTokenBalances: (tx.meta.preTokenBalances ?? []).map(toRaw),
      postTokenBalances: (tx.meta.postTokenBalances ?? []).map(toRaw),
    };
  }
}
