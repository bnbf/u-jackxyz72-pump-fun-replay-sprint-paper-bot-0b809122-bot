// Early-momentum sniper for the pump.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte in vendor/.
//
// Strategy in one paragraph: watch every new bonding curve from its CreateEvent and
// buy only the launches whose opening tape already proves demand — at least 5 trades,
// 4 distinct non-creator buyers, 3 SOL of net inflow, and the creator buying in, all
// inside the first 8 slots, with the price up a little but not already pumped. Take a
// 0.15 SOL stake per coin in small adds, then exit fast: a -8% stop, a 30% trailing stop
// once the position is +10%, a hard 800-slot time limit, and immediate exits when the
// creator sells, the tape goes stale, or the flow fades. Almost every pump.fun coin ends
// far below its peak, so the bot never holds to the end of the window; a few runners
// riding the wide trail pay for the many small stopped-out losers. Deterministic by
// construction: no clock, no randomness, no I/O — only the batches the harness sends.

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
