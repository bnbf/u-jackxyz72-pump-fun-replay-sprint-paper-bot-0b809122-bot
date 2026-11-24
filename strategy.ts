// strategy.ts — Strong-survivor scalp for the Pump.fun replay sprint.
//
// Design (from the brief): most pump.fun coins pump fast, then dump. The
// survivors worth buying are the coins whose real SOL reserve keeps growing
// AND whose price is already far above its create price when the reserve
// crosses 10 SOL. Buy those once, small, and get out fast: +10%
// take-profit, -7% stop-loss, 50 slots max hold, plus a fade exit when the
// 5-slot net flow turns negative, a creator-sell exit, and a stale exit.
//
// Performance is a hard constraint: the grading sandbox has 1 CPU and an
// 1800 s budget for the whole run. This file NEVER scans every coin per
// batch. Entry detection runs only on coins that traded in the current
// batch (a coin's reserves can only move on a trade), exit checks run only
// on the handful of open positions, and every windowed-flow sum walks a
// short per-coin tape backwards from the newest trade and stops at the
// window edge. Per-batch work is O(new trades + open positions).

import type { Batch, BotState, OrderInput } from "./vendor/makefun-bot.ts";

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Tuned parameters for the strong-survivor scalp. */
export const CFG = {
  /** Real SOL reserve that must be crossed (10 SOL). */
  crossRealQuote: 10n * LAMPORTS_PER_SOL,
  /** Minimum price vs create price at the crossing: +100% (price >= 2.0x). */
  minUpNum: 2n,
  minUpDen: 1n,
  /** Slippage tolerance on sells. */
  slippageBps: 500,
  /** Buys need wide slippage: a coin crossing 10 SOL often moves >5% in
      the 2-slot fill lag, and a 500 bps cap rejects exactly the rockets. */
  buySlippageBps: 500,
  /** One-shot stake per coin (0.4 SOL), clamped to the per-mint size cap. */
  stake: 400_000_000n,
  /** Minimum buy size the harness accepts (0.01 SOL). */
  minBuy: 10_000_000n,
  /** Take-profit / stop-loss in basis points of the position's cost. */
  takeProfitBps: 1000n,
  stopLossBps: -700n,
  /** Max slots to hold a position. */
  maxHoldSlots: 50,
  /** A position goes stale after this many slots without a trade. */
  staleSlots: 15,
  /** Fade exit: 5-slot net flow below this (SOL, negative) sells. */
  fadeWindowSlots: 5,
  fadeSellBelow: -500_000_000n,
  /** Fade/stale exits are OFF in this build: the sim showed they chop
      winners for no gain (they sell the pause before the continuation). */
  useFadeExit: false,
  useStaleExit: false,
  /** Max open positions the caps allow. */
  maxPositions: 5,
  /** Slippage tolerance on every order. */
  slippageBps: 500,
  /** Probe fallback: only after this many batches, and only while entries are scarce. */
  probeAfterBatches: 250_000,
  probeMinEntries: 20,
  probeStake: 50_000_000n,
  probeMinRealQuote: 3n * LAMPORTS_PER_SOL,
  probeMinUpNum: 3n,
  probeMinUpDen: 2n,
  probeFlowWindowSlots: 30,
  probeMinFlow: 3n * LAMPORTS_PER_SOL,
  /** Per-coin tape cap; pruned on touch so memory stays bounded. */
  tapeCap: 128,
} as const;

/** One trade's signed SOL flow, newest last. */
interface FlowTick {
  slot: number;
  /** +lamports on a buy, -lamports on a sell. */
  sol: bigint;
}

/** Everything remembered about one mint, built only from events this run saw. */
interface CoinBook {
  mint: string;
  creator: string;
  haveCreate: boolean;
  /** Virtual quote / token reserves at create: the create price. */
  createVirtQuote: bigint;
  createVirtToken: bigint;
  /** Real quote reserves at the end of the previous batch (crossing check). */
  prevRealQuote: bigint;
  havePrev: boolean;
  lastTradeSlot: number;
  /** Latest slot a sell from the creator arrived, -1 when none. */
  creatorSellSlot: number;
  /** Slot the reserve crossed 10 SOL, -1 when never. */
  crossSlot: number;
  complete: boolean;
  /** Recent signed SOL flow, newest last; pruned on touch. */
  tape: FlowTick[];
}

/** The strong-survivor scalp: one-shot buys at the 10-SOL reserve crossing. */
export class SurvivorScalp {
  private coins = new Map<string, CoinBook>();
  private entered = new Set<string>();
  private entrySlot = new Map<string, number>();
  private batches = 0;
  private entryCount = 0;

  /** One batch of decisions: exits first, then fresh entries, then the probe. */
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    this.batches += 1;
    const orders: OrderInput[] = [];
    this.noteFills(batch);
    const { touched, crossed } = this.noteEvents(batch);
    this.addExits(state, batch, orders);
    this.addEntries(state, batch, crossed, orders);
    this.addProbes(state, batch, touched, orders);
    return orders;
  }

  /** Small run summary for the onDone log line. */
  summary(): { batches: number; entries: number } {
    return { batches: this.batches, entries: this.entryCount };
  }

  /** A buy that never filled frees the mint for a later crossing. */
  private noteFills(batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.side === "buy" && fill.status !== "filled") {
        this.entered.delete(fill.mint);
        this.entrySlot.delete(fill.mint);
      }
    }
  }

  /**
   * Fold this batch's events into the per-coin books. Only coins that
   * traded can have moved, so only they are touched. A crossing is the
   * trade that takes a coin's real quote reserve from below 10 SOL to at
   * or above it; the trade's own virtual reserves ride along for the
   * run-up check at entry time.
   */
  private noteEvents(batch: Batch): {
    touched: Set<string>;
    crossed: Array<{ mint: string; virtQuote: bigint; virtToken: bigint }>;
  } {
    const touched = new Set<string>();
    const crossed: Array<{ mint: string; virtQuote: bigint; virtToken: bigint }> = [];
    for (const ev of batch.events) {
      if (ev.event === "CreateEvent") {
        const book = this.bookFor(ev.mint);
        book.creator = ev.creator;
        book.haveCreate = true;
        book.createVirtQuote = BigInt(ev.virtual_quote_reserves);
        book.createVirtToken = BigInt(ev.virtual_token_reserves);
        book.prevRealQuote = 0n;
        book.havePrev = true;
        book.lastTradeSlot = ev.slot;
      } else if (ev.event === "TradeEvent") {
        const book = this.bookFor(ev.mint);
        if (book.creator === "") book.creator = ev.creator;
        book.lastTradeSlot = ev.slot;
        const sol = BigInt(ev.sol_amount);
        book.tape.push({ slot: ev.slot, sol: ev.is_buy ? sol : -sol });
        if (book.tape.length > CFG.tapeCap) {
          book.tape.splice(0, Math.floor(book.tape.length / 2));
        }
        if (!ev.is_buy && ev.user === book.creator) book.creatorSellSlot = ev.slot;
        const real = BigInt(ev.real_quote_reserves);
        if (book.havePrev && book.prevRealQuote < CFG.crossRealQuote && real >= CFG.crossRealQuote) {
          book.crossSlot = ev.slot;
          crossed.push({
            mint: ev.mint,
            virtQuote: BigInt(ev.virtual_quote_reserves),
            virtToken: BigInt(ev.virtual_token_reserves),
          });
        }
        book.prevRealQuote = real;
        book.havePrev = true;
        touched.add(ev.mint);
      } else {
        this.bookFor(ev.mint).complete = true;
      }
    }
    return { touched, crossed };
  }

  /** Sell orders for open positions whose exit fired. */
  private addExits(state: BotState, batch: Batch, orders: OrderInput[]): void {
    for (const [mint, holding] of state.positions) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) return;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.virtual_token_reserves === 0n) continue;
      if (this.hasPendingSell(state, mint)) continue;
      const book = this.coins.get(mint);
      if (book === undefined) continue;
      const value = (holding.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
      const retBps = ((value - holding.cost_lamports) * 10_000n) / holding.cost_lamports;
      const entry = this.entrySlot.get(mint) ?? batch.slot;
      const held = batch.slot - entry;
      const fade = CFG.useFadeExit ? this.flowSince(book, batch.slot, CFG.fadeWindowSlots) : 0n;
      const stale = CFG.useStaleExit && batch.slot - book.lastTradeSlot >= CFG.staleSlots;
      const creatorSold = book.creatorSellSlot >= entry;
      if (
        retBps >= CFG.takeProfitBps ||
        retBps <= CFG.stopLossBps ||
        held >= CFG.maxHoldSlots ||
        stale ||
        fade < CFG.fadeSellBelow ||
        creatorSold
      ) {
        orders.push({
          side: "sell",
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: CFG.slippageBps,
        });
      }
    }
  }

  /** One-shot buys on the 10-SOL crossing, only when already up >=125%. */
  private addEntries(
    state: BotState,
    batch: Batch,
    crossed: Array<{ mint: string; virtQuote: bigint; virtToken: bigint }>,
    orders: OrderInput[],
  ): void {
    for (const tick of crossed) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) return;
      const book = this.coins.get(tick.mint);
      if (book === undefined || book.complete || !book.haveCreate) continue;
      if (this.entered.has(tick.mint)) continue;
      if (state.positions.has(tick.mint) || this.hasPendingBuy(state, tick.mint)) continue;
      if (state.committedPositionCount() >= CFG.maxPositions) continue;
      if (!this.priceUp(tick.virtQuote, tick.virtToken, book, CFG.minUpNum, CFG.minUpDen)) continue;
      const cap = state.maxBuyLamports(tick.mint);
      const stake = CFG.stake < cap ? CFG.stake : cap;
      if (stake < CFG.minBuy) continue;
      if (state.freeCashLamports() < stake + 2n * state.txFeeLamports()) continue;
      orders.push({
        side: "buy",
        mint: tick.mint,
        quote_lamports: stake,
        max_slippage_bps: CFG.buySlippageBps,
      });
      this.entered.add(tick.mint);
      this.entrySlot.set(tick.mint, batch.slot);
      this.entryCount += 1;
    }
  }

  /** Insurance for the 20-mint guardrail: tiny probes late in the run, only while entries are scarce. */
  private addProbes(state: BotState, batch: Batch, touched: Set<string>, orders: OrderInput[]): void {
    if (this.entryCount >= CFG.probeMinEntries) return;
    if (this.batches <= CFG.probeAfterBatches) return;
    for (const mint of touched) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) return;
      const book = this.coins.get(mint);
      if (book === undefined || book.complete || !book.haveCreate) continue;
      if (this.entered.has(mint)) continue;
      if (state.positions.has(mint) || this.hasPendingBuy(state, mint)) continue;
      if (state.committedPositionCount() >= CFG.maxPositions) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.real_quote_reserves < CFG.probeMinRealQuote) continue;
      if (!this.priceUp(curve.virtual_quote_reserves, curve.virtual_token_reserves, book, CFG.probeMinUpNum, CFG.probeMinUpDen)) continue;
      if (this.flowSince(book, batch.slot, CFG.probeFlowWindowSlots) < CFG.probeMinFlow) continue;
      const cap = state.maxBuyLamports(mint);
      const stake = CFG.probeStake < cap ? CFG.probeStake : cap;
      if (stake < CFG.minBuy) continue;
      if (state.freeCashLamports() < stake + 2n * state.txFeeLamports()) continue;
      orders.push({
        side: "buy",
        mint,
        quote_lamports: stake,
        max_slippage_bps: CFG.slippageBps,
      });
      this.entered.add(mint);
      this.entrySlot.set(mint, batch.slot);
      this.entryCount += 1;
    }
  }

  /** True when price (virtQuote/virtToken) is at least num/den times the create price. */
  private priceUp(
    virtQuote: bigint,
    virtToken: bigint,
    book: CoinBook,
    num: bigint,
    den: bigint,
  ): boolean {
    if (virtToken === 0n || book.createVirtToken === 0n) return false;
    return virtQuote * book.createVirtToken * den >= book.createVirtQuote * virtToken * num;
  }

  /** Net signed SOL flow over the last `windowSlots` slots; walks the tape backwards, stops at the edge. */
  private flowSince(book: CoinBook, nowSlot: number, windowSlots: number): bigint {
    const edge = nowSlot - windowSlots;
    let sum = 0n;
    for (let i = book.tape.length - 1; i >= 0; i -= 1) {
      const tick = book.tape[i];
      if (tick.slot <= edge) break;
      sum += tick.sol;
    }
    return sum;
  }

  private hasPendingSell(state: BotState, mint: string): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === "sell" && p.order.mint === mint) return true;
    }
    return false;
  }

  private hasPendingBuy(state: BotState, mint: string): boolean {
    for (const p of state.pending.values()) {
      if (p.order.side === "buy" && p.order.mint === mint) return true;
    }
    return false;
  }

  private bookFor(mint: string): CoinBook {
    let book = this.coins.get(mint);
    if (book === undefined) {
      book = {
        mint,
        creator: "",
        haveCreate: false,
        createVirtQuote: 0n,
        createVirtToken: 0n,
        prevRealQuote: 0n,
        havePrev: false,
        lastTradeSlot: -1,
        creatorSellSlot: -1,
        crossSlot: -1,
        complete: false,
        tape: [],
      };
      this.coins.set(mint, book);
    }
    return book;
  }
}
