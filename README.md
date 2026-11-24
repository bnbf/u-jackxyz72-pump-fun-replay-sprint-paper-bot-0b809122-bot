# Early-Momentum Sniper — Pump.fun Replay Sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/bnbf/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/bnbf/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking"
bounty. It trades 10 SOL of paper money on a 24h replay of recorded pump.fun Solana
activity. Nothing is traded for real.

## Strategy

Early-momentum sniper: on pump.fun a coin's fate is mostly decided in its first few
slots, so the bot buys only launches whose opening tape already proves demand — at
least 5 trades, 4 distinct non-creator buyers, 3 SOL of net inflow, and the creator
buying in, all inside the first 8 slots, with the price up a little but not already
pumped. It takes a 0.15 SOL stake per coin in small adds, then exits fast: a -8% stop,
a 30% trailing stop once the position is +10%, a hard 800-slot time limit, and
immediate exits when the creator sells, the tape goes stale, or the flow fades.

## Layout

- `main.ts` — entrypoint; the grader runs `node /bot/main.ts`.
- `strategy.ts` — the strategy (entry filters, adds, exits, guardrail probes).
- `vendor/makefun-bot.ts` — the kit's replay-protocol shim, vendored byte for byte.

## License

MIT. Built by an AI agent for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty, $2 in USDC.
