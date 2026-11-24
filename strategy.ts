// Survivor sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Why this shape: buying every launch loses on this data (the house sniper pilot
// ends -0.47 SOL, this bot's own early-momentum v1 -0.30 SOL). What does win is
// waiting for proof AND demanding the strongest proof. A coin whose real SOL
// reserve crosses 10 SOL is a survivor, but most survivors still dump: from the
// fill price the median coin is flat for ~10 slots, then -5.5% by +25 slots and
// -44% by +600 slots. The edge is only in the coins already up 2.25x+ from
// create at the crossing (minUp 1.25): those keep running often enough that a
// fast scalp — take +10%, stop -7%, out within 50 slots, exit on a 5-slot flow
// fade — is net positive across the whole flat region (minUp 1.0-2.0, TP 5-20%,
// hold 25-100 all positive offline). Weaker survivors (1.5-2x) are negative, so
// the entry filter is the whole game; adds were tested and hurt (they buy into
// the dump at higher prices), so positions are one-shot single buys.
// The trigger is one-shot: retrying the entry for 100 slots after the crossing
// buys dead-cat bounces and lost -6.8 SOL on dev (v3 grade). The 20-coin
// guardrail is covered by tiny probe round trips when the run's own coins lag
// the pace (the strong filter trades ~74 coins on dev, so the probe is insurance).
// A pure function of the batches: no clock, no randomness, no I/O.
//
// Fees: a round trip pays ~1.25% curve fee each way plus one 105k-lamport tx fee per
// order, so a trade needs roughly +3% to break even; the take-profit and the stop
// are set with that in mind. Sizing is capped by the harness: at most 1% of a
// curve's real SOL reserve per reply, so a first buy at the crossing is ~0.1-0.15 SOL.
//
// NOTE on the earlier +3.05 SOL simulator claim (v3/v4 notes): the offline sim had
// a lookahead bug — its windowed-flow loop walked a coin's trades from the END of
// the day backwards, so the entry filter read the coin's FUTURE flow. The honest
// replay (pumpfun_offline.py, correct windows, exit fills at trigger+2 slots)
// puts v4 at -6.1 SOL, matching its real -6.9 grade. Do not trust any sim number
// that was produced before that fix.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Survivor trigger: real SOL reserve crossing this (SOL), and the band it must stay in. */
  survRqMin: number;
  survRqMax: number;
  /** Net SOL inflow over the flow window that must still be coming in. */
  survMinNet: number;
  survFlowWindow: number;
  /** Price now over the create price at entry (fraction). */
  survMinUp: number;
  /** Stake per coin (SOL), first buy (SOL), most adds, add size (SOL). */
  stakeSol: number;
  firstSol: number;
  maxAdds: number;
  addSol: number;
  /** Adds only while the position is this young (slots) and the price is within this of the first buy. */
  addMaxAge: number;
  addMaxRunup: number;
  /** Net SOL inflow over the flow window an add still needs. */
  addMinNet: number;
  /** Exits: stop loss, take profit, trailing-stop arm / trail, max hold (slots). */
  stopLoss: number;
  takeProfit: number;
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
  /** Guardrail pacing: probe round trips when coins lag the pace. */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Settings from the honest offline replay (pumpfun_offline.py, correct windows,
// exit fills at trigger+2 slots): the strong-survivor scalp is positive across a
// broad flat region — minUp 1.0-2.0, TP 0.05-0.20, hold 25-100 all positive —
// these are its middle, not its single best cell.
export const DEFAULT_PARAMS: Params = {
  survRqMin: 10,
  survRqMax: 85,
  survMinNet: 3,
  survFlowWindow: 30,
  survMinUp: 1.25,
  stakeSol: 0.4,
  firstSol: 0.4,
  maxAdds: 0,
  addSol: 0.1,
  addMaxAge: 100,
  addMaxRunup: 0.5,
  addMinNet: 1,
  stopLoss: 0.07,
  takeProfit: 0.1,
  trailArm: 0.1,
  trail: 0.25,
  maxHold: 50,
  exitOnDevSell: true,
  staleSlots: 600,
  fadeWindow: 5,
  fadeNetSol: -0.5,
  buySlipBps: 10_000,
  sellSlipBps: 10_000,
  targetCoins: 30,
  paceSecs: 86_400,
  probeSol: 0.02,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
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
  devSold: boolean;
  lastTradeSlot: number;
  /** Decided for good: bought, exited, or completed. */
  done: boolean;
  complete: boolean;
  /** Real SOL reserve at the end of the last batch this coin traded in (for crossing detection). */
  prevRqSol: number;
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
        devSold: false,
        lastTradeSlot: -1,
        done: false,
        complete: false,
        prevRqSol: 0,
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
          if (!e.is_buy && e.user === t.creator) t.devSold = true;
          traded.add(e.mint);
        } else {
          tapeOf(e.mint).complete = true;
        }
      }
      // Drop trade history older than the longest window any check reads.
      for (const [mint, t] of tapes) {
        if (t.trades.length === 0) continue;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - 300) cut++;
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
        if (!exit && cost > 0 && value >= cost * (1 + p.takeProfit)) exit = true;
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

      // Survivor entries and adds, strongest flow first. The trigger is ONE-SHOT: a
      // coin is entered only on the batch where its real SOL reserve crosses survRqMin
      // from below. A band that retries for 100 slots after the crossing enters far
      // more coins — mostly dead-cat bounces of coins already dumping — and lost
      // -6.8 SOL on the dev window (v3 grade). The one-shot crossing with the strong
      // filter (price already 2.25x+ from create) is what the honest offline replay
      // validates at about +0.5 SOL; the earlier +3.0 SOL simulator claim was a
      // lookahead artifact (see the header note) and is retracted.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();

      // One-shot crossing detection from the curves' latest reserves.
      const crossing = new Set<Pubkey>();
      for (const mint of traded) {
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        const t = tapes.get(mint)!;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (t.prevRqSol < p.survRqMin && rqSol >= p.survRqMin) crossing.add(mint);
        t.prevRqSol = rqSol;
      }

      const candidates: { mint: Pubkey; net: number }[] = [];
      for (const mint of crossing) {
        const t = tapes.get(mint);
        if (t === undefined || t.done || t.complete) continue;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        candidates.push({ mint, net: flow(t, now, p.survFlowWindow) });
      }
      candidates.sort((a, b) => b.net - a.net || (a.mint < b.mint ? -1 : 1));

      for (const { mint } of candidates) {
        if (orders.length >= cap) break;
        const t = tapes.get(mint)!;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.survRqMin || rqSol > p.survRqMax) continue;
        if (flow(t, now, p.survFlowWindow) < p.survMinNet) continue;
        if (t.p0 <= 0 || price / t.p0 - 1 < p.survMinUp) continue;
        if (slotsLeft <= 0) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.firstSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < MIN_BUY_SOL) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        held.set(mint, { opened: now, invested: amount, peakValue: 0, firstPrice: price, adds: 0, filled: false, exiting: false, lastValue: 0 });
        t.done = true;
        slotsLeft--;
      }

      // Adds: pyramid into a young survivor position while flow stays strong.
      for (const [mint, h] of held) {
        if (orders.length >= cap) break;
        if (h.exiting || !h.filled || h.adds >= p.maxAdds) continue;
        if (h.invested >= p.stakeSol - MIN_BUY_SOL) continue;
        if (pendingByMint.has(mint)) continue;
        if (now - h.opened > p.addMaxAge) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (price > h.firstPrice * (1 + p.addMaxRunup)) continue;
        const t = tapeOf(mint);
        if (flow(t, now, p.survFlowWindow) < p.addMinNet) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.addSol, p.stakeSol - h.invested);
        if (amount > free - tx) amount = free - tx;
        if (amount < MIN_BUY_SOL) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        h.invested += amount;
        h.adds++;
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
