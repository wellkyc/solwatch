import { EventEmitter } from 'node:events';
import { isSolanaAddress } from './base58';
import { LAMPORTS_PER_SOL, parseTransaction } from './parser';
import { RpcClient } from './rpc';
import { StreamClient } from './stream';
import type { WalletEvent, WalletState } from './types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SEEN_LIMIT = 20_000;

export class Watcher extends EventEmitter {
  private readonly rpc: RpcClient;
  private readonly stream: StreamClient;
  private readonly seen = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(rpcUrl: string, wsUrl: string) {
    super();
    this.rpc = new RpcClient(rpcUrl);
    this.stream = new StreamClient(wsUrl);
    this.stream.on('logs', (wallet: string, signature: string) => this.enqueue(wallet, signature));
    this.stream.on('account', (wallet: string, lamports: number) =>
      this.emit('balance', wallet, lamports / LAMPORTS_PER_SOL),
    );
    this.stream.on('status', (status: string) => this.emit('status', status));
    this.stream.on('warn', (message: string) => this.emit('warn', message));
  }

  async add(address: string): Promise<WalletState> {
    if (!isSolanaAddress(address)) throw new Error(`Invalid Solana address: ${address}`);
    const lamports = await this.rpc.getBalance(address);
    this.stream.subscribe('logs', address);
    this.stream.subscribe('account', address);
    return { address, sol: lamports / LAMPORTS_PER_SOL, events: 0 };
  }

  remove(address: string): void {
    this.stream.unsubscribe('logs', address);
    this.stream.unsubscribe('account', address);
  }

  async history(address: string, limit: number): Promise<WalletEvent[]> {
    const signatures = await this.rpc.getSignatures(address, limit);
    const events: WalletEvent[] = [];
    for (const { signature } of signatures) {
      try {
        const event = await this.load(address, signature, 1);
        if (event) events.push(event);
      } catch (error) {
        this.emit('warn', `History ${signature}: ${(error as Error).message}`);
      }
      await sleep(250);
    }
    return events;
  }

  close(): void {
    this.stream.close();
  }

  private enqueue(wallet: string, signature: string): void {
    this.queue = this.queue
      .then(() => this.load(wallet, signature, 6))
      .then((event) => {
        if (event) this.emit('event', event);
      })
      .catch((error: Error) => {
        this.emit('warn', `Live ${signature}: ${error.message}`);
      });
  }

  private async load(wallet: string, signature: string, attempts: number): Promise<WalletEvent | null> {
    const id = `${signature}:${wallet}`;
    if (this.seen.has(id)) return null;
    if (this.seen.size > SEEN_LIMIT) this.seen.clear();
    this.seen.add(id);

    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const tx = await this.rpc.getTransaction(signature);
        if (tx) return parseTransaction(tx, wallet);
        await sleep(800 * (attempt + 1));
      }
    } catch (error) {
      this.seen.delete(id);
      throw error;
    }

    this.seen.delete(id);
    return null;
  }
}
