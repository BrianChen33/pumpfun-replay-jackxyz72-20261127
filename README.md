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
  SOL volume, ≥ 5 distinct non-creator buyers, largest non-creator buyer ≤ 40%
  of non-creator buy volume, creator buys ≤ 40% of buy volume, +8–30%
  appreciation from first trade, ≥ 3.125 SOL real reserve, price within 5% of
  the observed high, net inflow ≥ 3% of real reserve, unabsorbed creator
  selling < 0.05 SOL, and a real trade within the last 3 slots. Candidates are
  scored 0–100 (inflow persistence, absorption, dispersion, price confirmation,
  reserve depth, acceleration); normal entries need ≥ 72, high-conviction
  (≥ 80, ≥ 7 buyers, buy share ≥ 75%, inflow ≥ 0.80 SOL, largest ≤ 30%,
  reserve ≥ 10 SOL, within 3% of high) size up and may enter at up to +45%
  appreciation (the +45% allowance requires the full high-conviction set).
- **Entry (continuation, 18–250 slots):** tight consolidation (≤ 12% range over
  30 slots) breaking 1–10% above its prior high with buy-volume acceleration
  (last 10 slots ≥ 1.5× the previous 10 slots) and buy share ≥ 70%, score ≥ 72,
  largest non-creator buyer ≤ 40%, creator buys ≤ 40%, non-creator inflow
  excluding the largest buyer positive.
- **Sizing:** 0.08 SOL standard, 0.20 SOL high-conviction, 0.12 SOL continuation;
  internal cap 80 bps of real reserve; max 1 SOL initial exposure, max 3
  concurrent positions (5 in qualification mode). Qualification trades are
  0.03 SOL, never sized below the 0.025 SOL minimum order by risk reductions.
- **Exits:** single take-profit +100% (sell all, 800 bps slippage), stop-loss
  −20% (2,000 bps), 150-slot max hold, exit after 25 slots without a trade,
  trailing stop (arms once the peak gain reaches +20%, exits on a 15%
  retracement from the peak), and a momentum-failure exit (20+ slots held,
  gain ≤ +3%, recent 10-slot net flow negative). A failed or rejected
  take-profit sell simply re-fires on the next reply (no one-shot flag).
- **Guardrails:** qualification pacing targets 30 distinct round-tripping mints
  (minimum 20, each ≥ 0.01 SOL of buy fills — the official round-trip rule,
  mirrored locally: a mint counts when its position closes for any reason with
  buy quote ≥ 0.01 SOL) with a relaxed qualification mode (0.03 SOL,
  score ≥ 58, tighter TP/stop/hold) if behind pace; pacing counts open
  positions as well as confirmed ones; internal drawdown tiers
  (75% sizing at 3%, 50% at 6%, pause at 10%, close-all at 15%).

Two pyramid variants were tested locally and rejected: equity-scaled compounding
(V6, dev −1.57 SOL) and selective adds at +100% from average entry (V7, dev
−0.19 SOL, stress median −0.35 vs V4's −0.36). Offline analysis showed no early
feature strongly predicts a 3x runner, so adds are disabled in the submitted
version.

## Local grading (dev window)

- **V8 (submitted): net PnL +0.0008 SOL** (+0.01%), 50 round trips, 32.0% win
  rate, max drawdown 0.94%, fees 0.060 SOL, Sharpe +0.00; constraints compliant;
  official round-trip count 50 distinct mints (≥ 20 required); 90% interval
  [−0.132, +0.152] SOL. Two runs reproduce byte-identical action logs
  (deterministic).
- V4 (pre-review): net +0.018 SOL, 91 round trips, 34.1% win rate, max
  drawdown 2.4%. V8 trades less often (stricter creator/freshness gates) with
  a much tighter outcome interval; the +0.017 SOL difference is within noise.
  A 20-copy stress test of V4 (reshuffled trade blocks) gave median −0.36 SOL,
  1/20 positive — the dev score is window-specific, not a robust edge; the bot
  is submitted as a compliant, near-breakeven baseline rather than a claimed
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
