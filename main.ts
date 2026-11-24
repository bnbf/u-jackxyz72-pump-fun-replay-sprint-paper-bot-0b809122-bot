// main.ts — entrypoint for the Pump.fun replay sprint bot.
//
// Wiring only: the strategy lives in strategy.ts. runBot owns the wire
// (stdin/stdout JSON lines, one reply per batch); this file hands it a
// fresh SurvivorScalp and logs a one-line summary to stderr at the end.
// No clock, no randomness, no environment reads: the run is fully
// deterministic, so the grader's two executions produce byte-identical
// action logs.

import { runBot } from "./vendor/makefun-bot.ts";
import type { Batch, BotState, Done } from "./vendor/makefun-bot.ts";
import { SurvivorScalp } from "./strategy.ts";

const scalp = new SurvivorScalp();

/** Build the bot object runBot drives: one batch in, orders out. */
function buildBot(): {
  onHello(state: BotState): void;
  onBatch(state: BotState, batch: Batch): ReturnType<SurvivorScalp["onBatch"]>;
  onDone(state: BotState, done: Done): void;
} {
  return {
    onHello(state: BotState): void {
      console.error(`hello: seed=${state.hello.seed} cash=${state.cash}`);
    },
    onBatch(state: BotState, batch: Batch) {
      return scalp.onBatch(state, batch);
    },
    onDone(state: BotState, _done: Done): void {
      const { batches, entries } = scalp.summary();
      console.error(
        `done: batches=${batches} entries=${entries} cash=${state.cash} positions=${state.positions.size}`,
      );
    },
  };
}

// Speak agent-fun/replay/v2 on stdin/stdout until the harness sends done,
// then stop reading and resolve; the process exits once stdout drains.
await runBot(buildBot());
