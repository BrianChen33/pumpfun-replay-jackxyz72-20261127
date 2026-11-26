# Pump.fun Replay Sprint — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/BrianChen33/pumpfun-replay-jackxyz72-20261127/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/BrianChen33/pumpfun-replay-jackxyz72-20261127/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

An entry for the [make.fun](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty
"Pump.fun Replay Sprint — Paper Bot, Real Ranking". A TypeScript bot that trades
10 SOL of paper money on a 24h pump.fun replay. Best net PnL wins.

## Strategy

Flow-confirmed early-momentum breakout with order-flow confirmation, fixed
small sizes, and plain single-take-profit exits — written from scratch for
this competition (hand-written by Muse in session; GPT-6.2 Astra High advised
the design only, no ChatGPT-written code is used):

- **Entry (primary, 5–18 slots after first trade):** requires persistent net SOL
  inflow (≥ 0.50 SOL, positive across two sub-windows), buy share ≥ 65% of gross
  SOL volume, ≥ 5 distinct non-creator buyers, largest buyer ≤ 40% of buy volume,
  +8–30% appreciation from first trade, ≥ 3 SOL real reserve, price within 5% of
  the observed high, net inflow ≥ 3% of real reserve, and no unabsorbed creator
  selling. Candidates are scored 0–100 (inflow persistence, absorption, dispersion,
  price confirmation, reserve depth, acceleration); normal entries need ≥ 72,
  high-conviction (≥ 80, ≥ 7 buyers, buy share ≥ 75%, inflow ≥ 0.80 SOL,
  largest ≤ 30%, reserve ≥ 10 SOL, within 3% of high) size up and may enter at
  up to +45% appreciation.
- **Entry (continuation, 18–250 slots):** tight consolidation (≤ 12% range over
  30 slots) breaking 1–3% above its prior high with buy-volume acceleration
  (≥ 1.5×) and buy share ≥ 70%, score ≥ 72.
- **Sizing:** 0.08 SOL standard, 0.20 SOL high-conviction, 0.12 SOL continuation;
  internal cap 80 bps of real reserve; max 1 SOL initial exposure, max 3
  concurrent positions (5 in qualification mode).
- **Exits:** single take-profit +100% (sell all), stop-loss −20%, 150-slot max
  hold, exit after 25 slots without a trade. No trailing stop, no profit ladder.
- **Guardrails:** qualification pacing targets 30 distinct round-tripping mints
  (minimum 20, each ≥ 0.01 SOL) with a relaxed qualification mode (0.03 SOL,
  score ≥ 58, tighter TP/stop/hold) if behind pace; internal drawdown tiers
  (75% sizing at 3%, 50% at 6%, pause at 10%, close-all at 15%).

Two pyramid variants were tested locally and rejected: equity-scaled compounding
(V6, dev −1.57 SOL) and selective adds at +100% from average entry (V7, dev
−0.19 SOL, stress median −0.35 vs V4's −0.36). Offline analysis showed no early
feature strongly predicts a 3x runner, so adds are disabled in the submitted
version.

## Local grading (dev window)

- Net PnL **+0.018 SOL** (+0.18%), 91 round trips, 34.1% win rate, max
  drawdown 2.4%, fees 0.149 SOL, Sharpe +0.02; constraints compliant;
  90% interval [−0.463, +0.484] SOL. Two runs reproduce byte-identical action
  logs (deterministic).
- 20-copy stress test (reshuffled trade blocks): median −0.36 SOL, 1/20
  positive — the dev score is window-specific, not a robust edge; the bot is
  submitted as a compliant, near-breakeven baseline rather than a claimed
  winning edge.

## Determinism

No clock, no environment, no randomness. Every decision derives from the replay
stream (slots, events, fills). Candidate ranking uses explicit deterministic
tie-breaks (score, inflow, mint address), and the bot is executed twice with
byte-identical action logs.

## Files

- `main.ts` — the bot (single entrypoint, run as `node main.ts`)
- `vendor/makefun-bot.ts` — the kit's bot shim, copied verbatim (excluded from
  authorship counts per the kit's own instructions)

## Local grading

From the competition kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/this/repo --driver process --worktree
```
