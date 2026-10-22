export type EventKind = 'swap' | 'receive' | 'send' | 'failed' | 'other';

export interface AssetChange {
  mint: string;
  symbol: string;
  amount: number;
}

export interface WalletEvent {
  id: string;
  signature: string;
  wallet: string;
  time: number;
  kind: EventKind;
  changes: AssetChange[];
  fee: number;
  feePayer: boolean;
}

export interface WalletState {
  address: string;
  sol: number;
  events: number;
}

export interface RawTokenBalance {
  mint: string;
  owner?: string;
  amount: string;
}

export interface RawTx {
  signature: string;
  blockTime: number | null;
  fee: number;
  err: boolean;
  accountKeys: string[];
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: RawTokenBalance[];
  postTokenBalances: RawTokenBalance[];
}

export type ClientMessage =
  | { type: 'watch'; address: string }
  | { type: 'unwatch'; address: string };

export type ServerMessage =
  | { type: 'state'; wallets: WalletState[]; events: WalletEvent[]; rpc: string }
  | { type: 'wallet'; wallet: WalletState }
  | { type: 'removed'; address: string }
  | { type: 'event'; event: WalletEvent }
  | { type: 'error'; message: string };
