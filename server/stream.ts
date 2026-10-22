import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

type Channel = 'logs' | 'account';

interface Subscription {
  key: string;
  channel: Channel;
  address: string;
  serverId?: number;
}

interface StreamMessage {
  id?: number;
  result?: number;
  error?: { message: string };
  method?: string;
  params?: { subscription: number; result: { value: { signature?: string; lamports?: number } } };
}

export class StreamClient extends EventEmitter {
  private socket?: WebSocket;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly pending = new Map<number, Subscription>();
  private readonly active = new Map<number, Subscription>();
  private nextId = 1;
  private heartbeat?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly url: string) {
    super();
    this.connect();
  }

  subscribe(channel: Channel, address: string): void {
    const key = `${channel}:${address}`;
    if (this.subscriptions.has(key)) return;
    const subscription: Subscription = { key, channel, address };
    this.subscriptions.set(key, subscription);
    if (this.isOpen()) this.sendSubscribe(subscription);
  }

  unsubscribe(channel: Channel, address: string): void {
    const key = `${channel}:${address}`;
    const subscription = this.subscriptions.get(key);
    if (!subscription) return;
    this.subscriptions.delete(key);
    if (subscription.serverId !== undefined) {
      this.active.delete(subscription.serverId);
      this.sendUnsubscribe(channel, subscription.serverId);
    }
  }

  close(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
    this.socket?.close();
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on('open', () => {
      this.emit('status', 'online');
      for (const subscription of this.subscriptions.values()) this.sendSubscribe(subscription);
      this.heartbeat = setInterval(() => socket.ping(), 30_000);
    });

    socket.on('message', (data) => {
      try {
        this.handle(JSON.parse(data.toString()) as StreamMessage);
      } catch (error) {
        this.emit('warn', `Bad stream message: ${(error as Error).message}`);
      }
    });

    socket.on('close', () => {
      clearInterval(this.heartbeat);
      this.pending.clear();
      this.active.clear();
      for (const subscription of this.subscriptions.values()) subscription.serverId = undefined;
      if (this.closed) return;
      this.emit('status', 'offline');
      setTimeout(() => this.connect(), 3_000);
    });

    socket.on('error', (error) => this.emit('warn', `Stream error: ${error.message}`));
  }

  private send(id: number, method: string, params: unknown[]): void {
    this.socket?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }

  private sendSubscribe(subscription: Subscription): void {
    const id = this.nextId++;
    this.pending.set(id, subscription);
    const params =
      subscription.channel === 'logs'
        ? [{ mentions: [subscription.address] }, { commitment: 'confirmed' }]
        : [subscription.address, { encoding: 'base64', commitment: 'confirmed' }];
    this.send(id, `${subscription.channel}Subscribe`, params);
  }

  private sendUnsubscribe(channel: Channel, serverId: number): void {
    if (this.isOpen()) this.send(this.nextId++, `${channel}Unsubscribe`, [serverId]);
  }

  private handle(message: StreamMessage): void {
    if (message.id !== undefined) {
      const subscription = this.pending.get(message.id);
      if (!subscription) return;
      this.pending.delete(message.id);
      if (message.error || message.result === undefined) {
        this.emit('warn', `Subscribe ${subscription.key} failed: ${message.error?.message ?? 'no result'}`);
        return;
      }
      if (!this.subscriptions.has(subscription.key)) {
        this.sendUnsubscribe(subscription.channel, message.result);
        return;
      }
      subscription.serverId = message.result;
      this.active.set(message.result, subscription);
      return;
    }

    if (!message.params) return;
    const subscription = this.active.get(message.params.subscription);
    if (!subscription) return;
    const value = message.params.result.value;

    if (message.method === 'logsNotification' && value.signature) {
      this.emit('logs', subscription.address, value.signature);
    } else if (message.method === 'accountNotification' && value.lamports !== undefined) {
      this.emit('account', subscription.address, value.lamports);
    }
  }
}
