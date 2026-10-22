import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { Watcher } from './watcher';
import type { ClientMessage, ServerMessage, WalletEvent, WalletState } from './types';

if (existsSync('.env')) process.loadEnvFile('.env');

const PORT = Number(process.env.PORT ?? 8787);
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const WS_URL = process.env.WS_URL || RPC_URL.replace(/^http/, 'ws');
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT ?? 15);
const MAX_EVENTS = 500;
const STORE_FILE = resolve('wallets.json');
const WEB_ROOT = resolve('dist/web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const watcher = new Watcher(RPC_URL, WS_URL);
const wallets = new Map<string, WalletState>();
let events: WalletEvent[] = [];

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const file = normalize(join(WEB_ROOT, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)));
  if (!file.startsWith(WEB_ROOT + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    const hint = existsSync(WEB_ROOT) ? 'Not found' : 'Web UI is not built. Run: npm run build';
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(hint);
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(message: ServerMessage): void {
  for (const client of wss.clients) send(client, message);
}

async function persist(): Promise<void> {
  await writeFile(STORE_FILE, JSON.stringify([...wallets.keys()], null, 2));
}

function pushEvent(event: WalletEvent): void {
  const wallet = wallets.get(event.wallet);
  if (!wallet || events.some((e) => e.id === event.id)) return;
  events.push(event);
  events.sort((a, b) => b.time - a.time);
  events = events.slice(0, MAX_EVENTS);
  wallet.events++;
  broadcast({ type: 'event', event });
  broadcast({ type: 'wallet', wallet });
}

async function addWallet(address: string): Promise<void> {
  const trimmed = address.trim();
  if (wallets.has(trimmed)) throw new Error('Wallet is already being watched');
  const wallet = await watcher.add(trimmed);
  wallets.set(wallet.address, wallet);
  broadcast({ type: 'wallet', wallet });
  await persist();
  console.log(`watching ${wallet.address}`);

  const past = await watcher.history(wallet.address, HISTORY_LIMIT);
  for (const event of past.reverse()) pushEvent(event);
}

async function removeWallet(address: string): Promise<void> {
  if (!wallets.delete(address)) return;
  watcher.remove(address);
  events = events.filter((e) => e.wallet !== address);
  broadcast({ type: 'removed', address });
  await persist();
  console.log(`stopped ${address}`);
}

watcher.on('event', pushEvent);
watcher.on('balance', (address: string, sol: number) => {
  const wallet = wallets.get(address);
  if (!wallet) return;
  wallet.sol = sol;
  broadcast({ type: 'wallet', wallet });
});
watcher.on('status', (status: string) => console.log(`stream ${status}`));
watcher.on('warn', (message: string) => console.warn(message));

wss.on('connection', (socket) => {
  send(socket, { type: 'state', wallets: [...wallets.values()], events, rpc: new URL(RPC_URL).host });

  socket.on('message', async (data) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      send(socket, { type: 'error', message: 'Malformed message' });
      return;
    }
    try {
      if (message.type === 'watch') await addWallet(message.address);
      else if (message.type === 'unwatch') await removeWallet(message.address);
    } catch (error) {
      send(socket, { type: 'error', message: (error as Error).message });
    }
  });
});

async function loadInitialWallets(): Promise<string[]> {
  const fromEnv = (process.env.WALLETS ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  let fromStore: string[] = [];
  if (existsSync(STORE_FILE)) {
    try {
      fromStore = JSON.parse(await readFile(STORE_FILE, 'utf8')) as string[];
    } catch {
      console.warn('wallets.json is corrupted, ignoring it');
    }
  }
  return [...new Set([...fromStore, ...fromEnv])];
}

server.listen(PORT, async () => {
  console.log(`solwatch running at http://localhost:${PORT}`);
  console.log(`rpc ${new URL(RPC_URL).host}`);
  for (const address of await loadInitialWallets()) {
    await addWallet(address).catch((error: Error) => console.warn(`skip ${address}: ${error.message}`));
  }
});

function shutdown(): void {
  watcher.close();
  wss.close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
