// Survivor sniper for the pump.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte in vendor/.
//
// Strategy in one paragraph: buying every launch loses on this data, so the bot waits
// for proof. It enters only when a coin's real SOL reserve crosses 10 SOL while net
// buy flow over the last 30 slots stays strong and the price is already up 50%+ from
// create — a survivor that keeps running — then pyramids into the run up to a 0.4 SOL
// stake, and exits fast: a -10% stop, a 25% trailing stop once +10% up, a 600-slot
// time limit, and immediate exits when the creator sells, the tape goes stale, or
// flow fades. Tiny probe round trips cover the 20-coin guardrail when the run's own
// coins lag the pace. Deterministic by construction: no clock, no randomness, no I/O
// — only the batches the harness sends.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot({
  ...createStrategy(DEFAULT_PARAMS),
  onDone(state, done) {
    // Diagnostics only; stdout carries replies, never logs.
    console.error(
      `done: ${done.reason} cash=${done.account.cash_lamports} ` +
        `positions=${done.account.positions.length} batches=${state.seq + 1}`,
    );
  },
});
