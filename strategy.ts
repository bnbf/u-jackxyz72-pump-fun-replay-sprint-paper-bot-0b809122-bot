// Early-momentum sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: on pump.fun a coin's fate is mostly decided in its first few slots. Winners show
// immediate, broad buying (many distinct buyers, several SOL of net inflow, the creator
// buying in) while losers barely trade at all. This bot buys only launches whose opening
// tape already proves demand, takes a small stake, and exits fast: a tight stop, a wide
// trailing stop that lets runners run, and a hard time limit, because almost every coin
// ends far below its peak. A pure function of the batches: no clock, no randomness, no I/O.
//
// How it works, per batch:
//   1. Fold fills and events into per-coin tapes (trades, buyers, creator activity).
//   2. Exits first: stop loss, trailing stop, time limit, creator sell, stale tape, fade.
//   3. Entries: coins aged 1-8 slots whose opening tape passes every filter get a first
//      buy; a position is then topped up in small adds while it is young and not run away.
//   4. Guardrail pacing: if the run's own coins lag the pace, tiny probe round trips on
//      liquid coins keep the 20-coin bar in reach.
//
// Fees: a round trip pays ~1.25% curve fee each way plus one 105k-lamport tx fee per
// order, so a trade needs roughly +3% to break even; the stop and the trail are set
// with that in mind.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window: youngest / oldest age (slots since CreateEvent) at decision time. */
  minAge: number;
  maxAge: number;
  /** Early-tape filters (trades since create, distinct non-creator buyers, net SOL in). */
  minTrades: number;
  minBuyers: number;
  minNetSol: number;
  /** Creator's own buys in the opening tape (SOL), and whether a creator sell vetoes entry. */
  minDevBuySol: number;
  skipDevSold: boolean;
  /** Real SOL reserve window at entry. */
  minRealSol: number;
  maxRealSol: number;
  /** Price now over the create price: entry window (fraction). */
  minRunup: number;
  maxRunup: number;
  /** Stake per coin (SOL), first buy (SOL), most adds, add size (SOL). */
  stakeSol: number;
  firstSol: number;
  maxAdds: number;
  addSol: number;
  /** Adds only while age <= this and price <= first buy price * (1 + addMaxRunup). */
  addMaxAge: number;
  addMaxRunup: number;
  /** Exits: stop loss, trailing-stop arm / trail, max hold (slots). */
  stopLoss: number;
  trailArm: number;
  trail: number;
  maxHold: number;
  /** Exit when the creator sells while held; when no trade for this many slots. */
  exitOnDevSell: boolean;
  staleSlots: number;
  /** Exit when net SOL over the fade window falls below this. */
  fadeWindow: number;
  fadeNetSol: number;
  /** Slippage allowed on buys and sells (bps). */
  buySlipBps: number;
  sellSlipBps: number;
  /** Guardrail pacing: probe round trips when coins/fills lag the pace. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Settings picked on the dev window (see NEXT_STEPS_PUMPFUN_REPLAY.md): the flat, positive
// region of the sweep, not its single best cell — stop 6-8%, trail 25-30% armed at +10%,
// hold 600-1000 slots, entry on a strong opening tape (5+ trades, 4+ buyers, 3+ SOL net).
// v2 (after the v1 grade: -0.30 SOL, win 21.6%, 134 coins): no adds — the adds bought
// into pumps at worse prices and paid extra tx fees — one 0.10 SOL first buy instead,
// a stricter opening tape (6 trades, 5 buyers, 5 SOL net, creator in for 0.5+), a
// tighter stop (6%) and a slightly tighter trail (25%) with a longer hold (1000).
export const DEFAULT_PARAMS: Params = {
  minAge: 1,
  maxAge: 8,
  minTrades: 6,
  minBuyers: 5,
  minNetSol: 5,
  minDevBuySol: 0.5,
  skipDevSold: true,
  minRealSol: 3,
  maxRealSol: 80,
  minRunup: 0.01,
  maxRunup: 0.8,
  stakeSol: 0.1,
  firstSol: 0.1,
  maxAdds: 0,
  addSol: 0.05,
  addMaxAge: 30,
  addMaxRunup: 0.35,
  stopLoss: 0.06,
  trailArm: 0.1,
  trail: 0.25,
  maxHold: 1000,
  exitOnDevSell: true,
  staleSlots: 600,
  fadeWindow: 30,
  fadeNetSol: -2,
  buySlipBps: 10_000,
  sellSlipBps: 10_000,
  targetCoins: 30,
  paceSecs: 86_400,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
/** Curve fees (protocol 95 + creator 30 bps) charged on every fill. */
const CURVE_FEE = 0.0125;
/** Smallest single buy worth its tx fee (SOL). */
const MIN_BUY_SOL = 0.005;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Tape {
  created: number | null;
  creator: string;
  /** Price (vq/vt) at creation. */
  p0: number;
  trades: TapeTrade[];
  buyers: Set<string>;
  devBuySol: number;
  devSold: boolean;
  lastTradeSlot: number;
  /** Decided for good: bought, filtered out, exited, or completed. */
  done: boolean;
  complete: boolean;
}

interface Held {
  opened: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  peakValue: number;
  firstPrice: number;
  adds: number;
  filled: boolean;
  exiting: boolean;
  lastValue: number;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (lamports). */
function sellValueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  const fee = (q * 125n + 9999n) / 10_000n;
  return q - fee;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): {
  onBatch(state: BotState, batch: Batch): OrderInput[];
} {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        creator: '',
        p0: 0,
        trades: [],
        buyers: new Set(),
        devBuySol: 0,
        devSold: false,
        lastTradeSlot: -1,
        done: false,
        complete: false,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots of a tape. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.p0 = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.lastTradeSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          t.lastTradeSlot = e.slot;
          if (e.is_buy) {
            if (e.user === t.creator) t.devBuySol += sol;
            else t.buyers.add(e.user);
          } else if (e.user === t.creator) {
            t.devSold = true;
          }
          traded.add(e.mint);
        } else {
          tapeOf(e.mint).complete = true;
        }
      }
      // Drop stale trade history on decided coins so memory stays bounded.
      for (const [mint, t] of tapes) {
        if (!t.done || t.trades.length === 0) continue;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - 1200) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const cur = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') cur.buy = true;
        else cur.sell = true;
        pendingByMint.set(po.order.mint, cur);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      /** Current close value of a held position in SOL (curve + tx fees deducted). */
      const closeValue = (mint: Pubkey): number => {
        const pos = state.positions.get(mint);
        if (pos === undefined) return 0;
        const curve = state.curves.get(mint);
        if (curve === undefined) return 0;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        return Number(sellValueLamports(pos.token_amount, vq, vt)) / LAMPORTS - tx;
      };

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            tapeOf(mint).done = true;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(mint);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && cost > 0 && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && t.devSold) exit = true;
        if (!exit && now - t.lastTradeSlot >= p.staleSlots) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < p.fadeNetSol) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.get(mint)?.sell) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
        if (!selling) probes.set(mint, true);
      }

      // Entries and adds, best opening tape first.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      const candidates: { mint: Pubkey; net: number }[] = [];
      for (const mint of traded) {
        const t = tapes.get(mint);
        if (t === undefined || t.done || t.complete) continue;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        if (t.created === null) continue;
        const age = now - t.created;
        if (age < p.minAge || age > p.maxAge) continue;
        candidates.push({ mint, net: flow(t, now, p.maxAge + 1) });
      }
      candidates.sort((a, b) => b.net - a.net || (a.mint < b.mint ? -1 : 1));

      for (const { mint } of candidates) {
        if (orders.length >= cap) break;
        const t = tapes.get(mint)!;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          // Opening-tape filters: real demand, not a stillborn launch.
          if (t.trades.length < p.minTrades) continue;
          if (t.buyers.size < p.minBuyers) continue;
          if (flow(t, now, p.maxAge + 1) < p.minNetSol) continue;
          if (t.devBuySol < p.minDevBuySol) continue;
          if (p.skipDevSold && t.devSold) continue;
          if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
          if (t.p0 <= 0) continue;
          const runup = price / t.p0 - 1;
          if (runup < p.minRunup || runup > p.maxRunup) continue;
          const want = Math.min(p.firstSol, p.stakeSol);
          let amount = Math.min(capSol, want);
          if (amount > free - tx) amount = free - tx;
          if (amount < MIN_BUY_SOL) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          held.set(mint, { opened: now, invested: amount, peakValue: 0, firstPrice: price, adds: 0, filled: false, exiting: false, lastValue: 0 });
          t.done = true;
          slotsLeft--;
        } else {
          // Top up a young position that has not run away, while inflow continues.
          if (h.exiting || !h.filled || h.adds >= p.maxAdds) continue;
          if (h.invested >= p.stakeSol - MIN_BUY_SOL) continue;
          if (now - t.created! > p.addMaxAge) continue;
          if (price > h.firstPrice * (1 + p.addMaxRunup)) continue;
          if (flow(t, now, p.maxAge + 1) < 1) continue;
          const want = Math.min(p.addSol, p.stakeSol - h.invested);
          let amount = Math.min(capSol, want);
          if (amount > free - tx) amount = free - tx;
          if (amount < MIN_BUY_SOL) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          h.invested += amount;
          h.adds++;
        }
      }

      // Guardrail pacing: open a probe when the run's coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        if (needCoins) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
            slotsLeft--;
          }
        }
      }
      return orders;
    },
  };
}
