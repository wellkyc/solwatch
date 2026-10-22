import type { ServerMessage, WalletEvent, WalletState } from '../server/types';

type Filter = 'all' | 'swap' | 'transfer' | 'failed';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  status: $('status'),
  statusText: $('status-text'),
  form: $<HTMLFormElement>('watch-form'),
  input: $<HTMLInputElement>('address'),
  wallets: $('wallets'),
  walletCount: $('wallet-count'),
  walletsEmpty: $('wallets-empty'),
  filters: $('filters'),
  selection: $('selection'),
  selectionText: $('selection-text'),
  clearSelection: $('clear-selection'),
  feed: $('feed'),
  feedEmpty: $('feed-empty'),
  toast: $('toast'),
};

const wallets = new Map<string, WalletState>();
let events: WalletEvent[] = [];
let filter: Filter = 'all';
let selected: string | null = null;
let socket: WebSocket | null = null;
let rpcHost = '';
let toastTimer = 0;

const short = (address: string) => `${address.slice(0, 4)}...${address.slice(-4)}`;

const amountFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const smallFormat = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 });

function formatAmount(value: number): string {
  const abs = Math.abs(value);
  const text = abs >= 1 ? amountFormat.format(abs) : smallFormat.format(abs);
  return `${value < 0 ? '−' : '+'}${text}`;
}

function relativeTime(time: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showToast(message: string): void {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (ui.toast.hidden = true), 4000);
}

function setStatus(state: 'online' | 'offline' | 'connecting'): void {
  ui.status.className = `status ${state}`;
  ui.statusText.textContent =
    state === 'online' ? `live · ${rpcHost}` : state === 'offline' ? 'reconnecting...' : 'connecting...';
}

function matches(event: WalletEvent): boolean {
  if (selected && event.wallet !== selected) return false;
  if (filter === 'all') return true;
  if (filter === 'transfer') return event.kind === 'send' || event.kind === 'receive';
  return event.kind === filter;
}

function renderWallets(): void {
  ui.wallets.replaceChildren(
    ...[...wallets.values()].map((wallet) => {
      const item = el('li', `wallet${wallet.address === selected ? ' selected' : ''}`);
      item.title = wallet.address;
      item.addEventListener('click', () => select(wallet.address === selected ? null : wallet.address));

      const top = el('div', 'wallet-top');
      const remove = el('button', 'remove', '×');
      remove.title = 'Stop watching';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        send({ type: 'unwatch', address: wallet.address });
      });
      top.append(el('span', 'address', short(wallet.address)), remove);

      const stats = el('div', 'wallet-stats');
      const balance = el('span');
      balance.append(el('strong', '', amountFormat.format(wallet.sol)), ' SOL');
      const count = el('span');
      count.append(el('strong', '', String(wallet.events)), ' events');
      stats.append(balance, count);

      item.append(top, stats);
      return item;
    }),
  );
  ui.walletCount.textContent = String(wallets.size);
  ui.walletsEmpty.hidden = wallets.size > 0;
}

function renderChanges(event: WalletEvent): HTMLElement {
  const box = el('div', 'changes');
  if (event.kind === 'failed') {
    box.append(el('span', 'muted', 'transaction failed'));
    return box;
  }
  if (event.changes.length === 0) {
    box.append(el('span', 'muted', 'no balance change'));
    return box;
  }
  const outs = event.changes.filter((c) => c.amount < 0);
  const ins = event.changes.filter((c) => c.amount > 0);
  const part = (amount: number, symbol: string) =>
    el('span', `amount ${amount < 0 ? 'out' : 'in'}`, `${formatAmount(amount)} ${symbol}`);

  outs.forEach((c) => box.append(part(c.amount, c.symbol)));
  if (outs.length && ins.length) box.append(el('span', 'arrow', '→'));
  ins.forEach((c) => box.append(part(c.amount, c.symbol)));
  return box;
}

function renderEvent(event: WalletEvent): HTMLElement {
  const row = el('li', 'event');

  const who = el('div', 'who');
  const address = el('span', 'address', short(event.wallet));
  address.title = event.wallet;
  address.addEventListener('click', () => select(event.wallet));
  const time = el('span', 'time', relativeTime(event.time));
  time.dataset.time = String(event.time);
  time.title = new Date(event.time).toLocaleString();
  who.append(address, time);

  const link = el('a', 'tx-link', short(event.signature));
  link.href = `https://solscan.io/tx/${event.signature}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = 'Open in Solscan';

  row.append(el('span', `badge ${event.kind}`, event.kind), who, renderChanges(event), link);
  return row;
}

function renderFeed(): void {
  const visible = events.filter(matches);
  ui.feed.replaceChildren(...visible.map(renderEvent));
  ui.feedEmpty.hidden = visible.length > 0;
  ui.feedEmpty.textContent = wallets.size === 0 ? 'No wallets yet.' : 'Nothing yet.';
  ui.selection.hidden = selected === null;
  if (selected) ui.selectionText.textContent = `Showing ${short(selected)}`;
}

function select(address: string | null): void {
  selected = address;
  renderWallets();
  renderFeed();
}

function handle(message: ServerMessage): void {
  switch (message.type) {
    case 'state':
      rpcHost = message.rpc;
      wallets.clear();
      message.wallets.forEach((w) => wallets.set(w.address, w));
      events = message.events;
      setStatus('online');
      renderWallets();
      renderFeed();
      break;
    case 'wallet':
      wallets.set(message.wallet.address, message.wallet);
      renderWallets();
      break;
    case 'removed':
      wallets.delete(message.address);
      events = events.filter((e) => e.wallet !== message.address);
      if (selected === message.address) selected = null;
      renderWallets();
      renderFeed();
      break;
    case 'event':
      if (events.some((e) => e.id === message.event.id)) return;
      events.push(message.event);
      events.sort((a, b) => b.time - a.time);
      events = events.slice(0, 500);
      renderFeed();
      break;
    case 'error':
      showToast(message.message);
      break;
  }
}

function send(message: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  else showToast('Not connected to the server');
}

function connect(): void {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}/ws`);
  socket.addEventListener('message', (e) => handle(JSON.parse(e.data as string) as ServerMessage));
  socket.addEventListener('close', () => {
    setStatus('offline');
    setTimeout(connect, 2000);
  });
}

ui.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const address = ui.input.value.trim();
  if (!address) return;
  send({ type: 'watch', address });
  ui.input.value = '';
});

ui.filters.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
  if (!button) return;
  filter = button.dataset.filter as Filter;
  ui.filters.querySelectorAll('.chip').forEach((chip) => chip.classList.toggle('active', chip === button));
  renderFeed();
});

ui.clearSelection.addEventListener('click', () => select(null));

setInterval(() => {
  ui.feed.querySelectorAll<HTMLElement>('.time').forEach((node) => {
    node.textContent = relativeTime(Number(node.dataset.time));
  });
}, 10_000);

setStatus('connecting');
connect();
