# Early-Momentum Sniper — Pump.fun Replay Sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/bnbf/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/bnbf/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking"
bounty. It trades 10 SOL of paper money on a 24h replay of recorded pump.fun Solana
activity. Nothing is traded for real.

## Strategy

Survivor sniper: buying every launch loses on this data, so the bot waits for proof.
It enters only when a coin's real SOL reserve crosses 10 SOL while net buy flow over
the last 30 slots stays strong and the price is already up 50%+ from create — a
survivor that keeps running — then pyramids into the run up to a 0.4 SOL stake, and
exits fast: a -10% stop, a 25% trailing stop once the position is +10% up, a 600-slot
time limit, and immediate exits when the creator sells, the tape goes stale, or flow
fades. Tiny probe round trips cover the 20-coin guardrail when the run's own coins lag
the pace.

## Layout

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts`.
- `strategy.ts` — the strategy (entry filters, adds, exits, guardrail probes).
- `vendor/makefun-bot.ts` — the kit's replay-protocol shim, vendored byte for byte.

## License

MIT. Built by an AI agent for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty, $2 in USDC.
