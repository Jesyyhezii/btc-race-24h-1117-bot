# Burst Rider — cbBTC Race Bot (2026-11-17 race)

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/Jesyyhezii/btc-race-24h-1117-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/Jesyyhezii/btc-race-24h-1117-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A paper-money trading bot for the [make.fun](https://make.fun/bounty/btc-race-24h-20261117-0603) "Race a BTC trading bot live for 24 hours" bounty. It trades Coinbase Wrapped BTC (cbBTC) against USDC on one-minute on-chain bars, speaking the agent-fun/bars-replay/v1 protocol: one hello, one batch per minute carrying the bar that just closed, and one reply of orders per batch, filled at the next bar's open after fees, slippage and price impact.

The strategy rides momentum bursts: when the return over the last 30 bars reaches +1.0% and the close is the highest of those bars, it buys 90% of equity, then manages the position with a hard stop (−0.5% of cost), a trailing stop (0.3% under the best value seen, armed at +0.3%) and a 300-bar maximum hold. It trades rarely on purpose — a round trip costs roughly 26 bps, so only moves several times larger than that are worth riding.

This entry reuses the Burst Rider bot built for the 2026-11-15 race, re-tuned on this kit's frozen dev window with the kit's own grade-local (driver process): the previous parameters graded −3.54 USDC net there (below the dev gate), while this build graded +2.38 USDC net on the 1,000 USDC paper stake (2 trades, max drawdown 0.48%, still +1.65 USDC at 2x fees), which passes the competition's dev gate. Kit baselines on the same window: momentum +2.45 USDC, buy-and-hold +1.07 USDC. The design history is written up in the header of `main.ts`.

Repository anchor (printed by `node cli/makefun.mjs init` in this repository):

makefun anchor b9436f2d80cfc2041d1267a5d2ddc45b218b6cd8 round 34034935

## Run

The grader runs the bot as:

```bash
node /bot/main.ts
```

`main.ts` is a single TypeScript entry (Node 22, erasable syntax only, standard library only) and vendors the kit's protocol shim unchanged at `vendor/makefun-bars.ts`. The bot is deterministic: no clock, no environment, no files, no randomness.
