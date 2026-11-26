// Pump.fun Replay Sprint — paper trading bot (hand-written by Muse, 2026-11-27 session).
//
// Strategy (GPT-6.2 Astra High advised the design only; no ChatGPT-written code is used here).
//
// V4 (submitted config) — early-momentum breakout with order-flow confirmation,
// fixed small sizes, single take-profit, plain exits. Dev: net +0.018 SOL,
// 91 round trips, 34% win rate, max drawdown 2.4%.
//
// V7's selective pyramid (adds at +100% from average entry, max 2, fixed 0.12 SOL)
// was tested and REJECTED: dev net fell to -0.19 SOL, and a 20-copy stress run
// (13/20 finished before a runtime restart; median -0.35 SOL, 0 positive) was
// statistically identical to V4's stress (20/20, median -0.36 SOL, 1 positive).
// Offline analysis explains why: no early feature predicts a 3x runner
// (best combo lifts P(3x) only from ~5% to ~7%), and even after +100% the
// add's risk/reward is poor (stop -47% vs the add price, TP +33%). So adds are
// disabled (MAX_ADDS = 0) and the exposure cap is back to V4's 1 SOL.
// With no adds, the hold clock (lastAddSlot) equals the entry slot and the
// volume-weighted entry price equals the first entry price, so this file is
// behaviorally identical to the graded V4.
//
// Determinism: no clock, no environment, no Math.random. All decisions derive
// from the replay stream (slots, events, fills). Candidate ranking uses explicit
// deterministic tie-breaks (score, inflow, mint address).

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- constants
const SOL = 1_000_000_000; // lamports per SOL, as a JS number (amounts stay < 2^53)
const MIN_AGE = 5; // primary entry window, slots since first trade
const MAX_AGE = 18;
const CONT_MAX_AGE = 250; // continuation window
const NORMAL_SIZE_SOL = 0.08;
const HIGH_SIZE_SOL = 0.2;
const CONT_SIZE_SOL = 0.12;
const ADD_SIZE_SOL = 0.12; // pyramid add size (fixed)
const MAX_ADDS = 0; // pyramid adds DISABLED (V7 tested, rejected: see header)
const ADD_MIN_GAIN = 1.0; // add only at +100% from average entry
const ADD_NEAR_HIGH = 0.97; // ... and price within 3% of the position peak
const ADD_MIN_GAP = 10; // slots between adds on one mint
const QUAL_SIZE_SOL = 0.03;
const MIN_ORDER_SOL = 0.025; // below this, fixed fees eat the trade
const MAX_EXPOSURE_SOL = 1.0; // hard initial-exposure cap (V4)
const FEE_RESERVE_SOL = 0.05; // cash kept back for tx fees
const STOP_PCT = 0.2;
const TP_PCT = 1.0;
const QUAL_STOP_PCT = 0.06;
const QUAL_TP_PCT = 0.13;
const QUAL_MAX_HOLD = 75;
const MAX_HOLD_SLOTS = 150;
const SCORE_NORMAL = 72;
const SCORE_HIGH = 80;
const SCORE_QUAL = 58;
const NORMAL_MIN_BUYERS = 5;
const NORMAL_MIN_INFLOW_SOL = 0.5;
const NORMAL_MAX_LARGEST_SHARE = 0.4;
const MIN_APPRECIATION = 0.08;
const MAX_APPRECIATION = 0.3;
const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 2000;
const MAX_NORMAL_POSITIONS = 3;
const MAX_POSITIONS = 5;
const MIN_BUY_LAMPORTS_QUAL = 10_000_000; // 0.01 SOL guardrail round trip

const lamports = (sol: number): bigint => BigInt(Math.round(sol * SOL));

// ---------------------------------------------------------------- per-mint candidate state
interface TradeRec {
  slot: number;
  buy: boolean;
  sol: number; // lamports, as a number
  user: string;
  price: number; // virtual quote / virtual token at this trade
}

interface Cand {
  mint: string;
  creator: string;
  firstSlot: number;
  firstPrice: number; // NaN until the first trade
  high: number;
  buyVol: number;
  sellVol: number;
  buyers: Map<string, number>; // non-creator buyer -> buy volume (lamports)
  largestBuy: number;
  lastCreatorSell: number; // lamports of the most recent creator sell
  buySinceCreatorSell: number; // buy volume since that creator sell
  trades: TradeRec[];
  lastTradeSlot: number;
  entered: boolean; // a buy fill landed for this mint
  complete: boolean;
}

// ---------------------------------------------------------------- position state
interface FlowBucket {
  slot: number;
  buy: number;
  sell: number;
}

interface Pos {
  mint: string;
  entryPrice: number; // volume-weighted average entry (SOL per token)
  entrySlot: number;
  tokensBought: bigint;
  tokensSold: bigint;
  buySol: number; // lamports spent incl. fees
  sellSol: number; // lamports received net of fees
  peak: number; // max price since entry
  adds: number;
  lastAddSlot: number; // slot of the last add fill (also resets the hold clock)
  tpDone: boolean;
  lastTradeSlot: number;
  flow: FlowBucket[]; // recent per-slot flow, capped
  qual: boolean; // qualification-mode trade: single small TP, tighter stop/hold
  stopPct: number;
  tpPct: number;
  maxHold: number; // slots, measured from lastAddSlot
}

// ---------------------------------------------------------------- run state
let startSlot: number | null = null;
const cands = new Map<string, Cand>();
const positions = new Map<string, Pos>();
const doneMints = new Set<string>(); // entered once: never re-enter
const retiredMints = new Set<string>(); // aged out of every window: never re-created
const qualified = new Set<string>(); // confirmed round-tripping mints
let recentOutcomes: boolean[] = []; // win = true, per closed round trip (cap 30)
let consecLosses = 0;
let fillOutcomes: Array<'ok' | 'fail'> = []; // last 20 fill outcomes
let pauseUntil = -1;
let halfSizeTradesLeft = 0;
let equityHigh = 10 * SOL; // lamports
let stopped = false; // capital preservation: DD >= 15%
const qualBuys = new Set<string>(); // mints bought as qualification-mode trades

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function getCand(mint: string, creator: string, slot: number): Cand {
  let c = cands.get(mint);
  if (c === undefined) {
    c = {
      mint,
      creator,
      firstSlot: slot,
      firstPrice: NaN,
      high: 0,
      buyVol: 0,
      sellVol: 0,
      buyers: new Map(),
      largestBuy: 0,
      lastCreatorSell: 0,
      buySinceCreatorSell: 0,
      trades: [],
      lastTradeSlot: slot,
      entered: false,
      complete: false,
    };
    cands.set(mint, c);
  }
  return c;
}

// ---------------------------------------------------------------- scoring
interface Agg {
  buyVol: number;
  sellVol: number;
  buyers: number; // distinct non-creator buyers
  largestShare: number; // largest buyer share of buy volume, 0..1
  netInflow: number; // lamports
  netExLargest: number; // lamports
  firstHalfNet: number;
  secondHalfNet: number;
}

function aggregate(trades: TradeRec[], creator: string): Agg {
  let buyVol = 0;
  let sellVol = 0;
  const buyers = new Map<string, number>();
  let largestBuy = 0;
  let firstHalfNet = 0;
  let secondHalfNet = 0;
  if (trades.length > 0) {
    const mid = trades[0].slot + Math.floor((trades[trades.length - 1].slot - trades[0].slot) / 2);
    for (const t of trades) {
      const net = t.buy ? t.sol : -t.sol;
      if (t.slot <= mid) firstHalfNet += net;
      else secondHalfNet += net;
      if (t.buy) {
        buyVol += t.sol;
        if (t.user !== creator) {
          const v = (buyers.get(t.user) ?? 0) + t.sol;
          buyers.set(t.user, v);
          if (v > largestBuy) largestBuy = v;
        }
      } else {
        sellVol += t.sol;
      }
    }
  }
  const netInflow = buyVol - sellVol;
  return {
    buyVol,
    sellVol,
    buyers: buyers.size,
    largestShare: buyVol > 0 ? largestBuy / buyVol : 0,
    netInflow,
    netExLargest: netInflow - largestBuy,
    firstHalfNet,
    secondHalfNet,
  };
}

// 100-point candidate score. `appreciation` is price/firstPrice - 1 (primary) or the
// breakout strength over the recent low (continuation). `high` is the observed high.
function scoreCandidate(a: Agg, appreciation: number, price: number, high: number, realReserveSol: number): number {
  let s = 0;
  // Net inflow persistence (25)
  const inflowSol = a.netInflow / SOL;
  if (inflowSol >= 0.8) s += 25;
  else if (inflowSol >= 0.5) s += 20;
  else if (inflowSol >= 0.3) s += 15;
  else if (inflowSol >= 0.15) s += 8;
  // Sell absorption (20); neutral 10 when there has been no meaningful selling
  if (a.sellVol >= 0.05 * SOL) {
    if (price >= 0.97 * high) s += 20;
    else if (price >= 0.9 * high) s += 12;
    else s += 4;
  } else {
    s += 10;
  }
  // Buyer dispersion (20)
  if (a.buyers >= 7 && a.largestShare <= 0.3) s += 20;
  else if (a.buyers >= 5 && a.largestShare <= 0.4) s += 15;
  else if (a.buyers >= 4 && a.largestShare <= 0.45) s += 10;
  else if (a.buyers >= 3) s += 5;
  // Price confirmation (15)
  if (appreciation >= 0.1 && appreciation <= 0.3 && price >= 0.98 * high) s += 15;
  else if (appreciation >= 0.06 && appreciation <= 0.35) s += 10;
  else if (appreciation > 0) s += 5;
  // Reserve depth (10)
  if (realReserveSol >= 25) s += 10;
  else if (realReserveSol >= 10) s += 8;
  else if (realReserveSol >= 5) s += 5;
  else if (realReserveSol >= 3) s += 3;
  // Volume acceleration (10): second-half flow stronger than first-half flow
  if (a.firstHalfNet > 0 && a.secondHalfNet > 0) {
    s += a.secondHalfNet >= a.firstHalfNet ? 10 : 6;
  }
  return s;
}

function creatorFilterOk(c: Cand): boolean {
  if (c.lastCreatorSell < 0.05 * SOL) return true;
  return c.buySinceCreatorSell >= c.lastCreatorSell;
}

// ---------------------------------------------------------------- helpers using harness state
function pendingSellTokens(state: any, mint: string): bigint {
  let total = 0n;
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell' && p.order.mint === mint) total += BigInt(p.order.token_amount);
  }
  return total;
}

function pendingBuySol(state: any): number {
  let total = 0;
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy') total += Number(BigInt(p.order.quote_lamports));
  }
  return total;
}

function hasPendingBuy(state: any, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && p.order.mint === mint) return true;
  }
  return false;
}

function recentFlow(pos: Pos, slot: number, windowSlots: number): number {
  let net = 0;
  for (const b of pos.flow) {
    if (b.slot > slot - windowSlots) net += b.buy - b.sell;
  }
  return net;
}

function closePosition(mint: string, won: boolean): void {
  const pos = positions.get(mint);
  if (pos === undefined) return;
  positions.delete(mint);
  doneMints.add(mint);
  if (pos.buySol >= MIN_BUY_LAMPORTS_QUAL && pos.tokensSold * 2n >= pos.tokensBought) {
    qualified.add(mint);
  }
  recentOutcomes.push(won);
  if (recentOutcomes.length > 30) recentOutcomes.shift();
  if (won) consecLosses = 0;
  else consecLosses += 1;
}

// ---------------------------------------------------------------- main loop
await runBot({
  onBatch(state, batch) {
    const slot = batch.slot;
    if (startSlot === null) startSlot = slot;
    const orders: Array<{ side: string; mint: string; quote_lamports?: bigint; token_amount?: bigint; max_slippage_bps: number }> = [];
    try {
      // ---- 1. reconcile fills ---------------------------------------------
      for (const f of batch.fills) {
        if (f.status === 'failed') {
          fillOutcomes.push('fail');
          if (fillOutcomes.length > 20) fillOutcomes.shift();
          continue;
        }
        if (f.status === 'rejected') continue;
        // filled
        fillOutcomes.push('ok');
        if (fillOutcomes.length > 20) fillOutcomes.shift();
        const mint = f.mint;
        if (f.side === 'buy') {
          const quote = Number(BigInt(f.quote_lamports));
          const tokens = BigInt(f.token_amount);
          if (tokens === 0n) continue;
          let pos = positions.get(mint);
          const entryPrice = quote / Number(tokens);
          if (pos === undefined) {
            const isQual = qualBuys.has(mint);
            qualBuys.delete(mint);
            pos = {
              mint,
              entryPrice,
              entrySlot: slot,
              tokensBought: tokens,
              tokensSold: 0n,
              buySol: quote,
              sellSol: 0,
              peak: entryPrice,
              adds: 0,
              lastAddSlot: slot,
              tpDone: false,
              lastTradeSlot: slot,
              flow: [],
              qual: isQual,
              stopPct: isQual ? QUAL_STOP_PCT : STOP_PCT,
              tpPct: isQual ? QUAL_TP_PCT : TP_PCT,
              maxHold: isQual ? QUAL_MAX_HOLD : MAX_HOLD_SLOTS,
            };
            positions.set(mint, pos);
          } else {
            // Pyramid add: re-average the entry price; reset the hold clock.
            const totalTokens = pos.tokensBought + tokens;
            pos.entryPrice = (pos.entryPrice * Number(pos.tokensBought) + entryPrice * Number(tokens)) / Number(totalTokens);
            pos.tokensBought = totalTokens;
            pos.buySol += quote;
            pos.adds += 1;
            pos.lastAddSlot = slot;
          }
          const cand = cands.get(mint);
          if (cand !== undefined) cand.entered = true;
          doneMints.add(mint);
        } else {
          // sell fill (ours, or a harness close: _complete/_flatten/_writeoff)
          const pos = positions.get(mint);
          if (pos === undefined) continue;
          pos.tokensSold += BigInt(f.token_amount);
          pos.sellSol += Number(BigInt(f.quote_lamports));
          const stillHeld = state.positions.has(mint);
          if (!stillHeld || f.client_id.startsWith('_')) {
            const won = pos.sellSol > pos.buySol;
            closePosition(mint, won);
          }
        }
      }
      // Positions the harness closed without a fill we saw: reconcile.
      for (const mint of [...positions.keys()]) {
        if (!state.positions.has(mint)) {
          const pos = positions.get(mint)!;
          closePosition(mint, pos.sellSol > pos.buySol);
        }
      }

      // ---- 2. fold events into candidate / position state -----------------
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!doneMints.has(e.mint) && !retiredMints.has(e.mint) && !cands.has(e.mint)) {
            getCand(e.mint, e.creator, e.slot);
          }
          const c = cands.get(e.mint);
          if (c !== undefined) c.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const held = positions.get(e.mint);
          if (held !== undefined) {
            held.lastTradeSlot = e.slot;
            const solAmt = Number(BigInt(e.sol_amount));
            const last = held.flow[held.flow.length - 1];
            if (last !== undefined && last.slot === e.slot) {
              if (e.is_buy) last.buy += solAmt;
              else last.sell += solAmt;
            } else {
              held.flow.push({ slot: e.slot, buy: e.is_buy ? solAmt : 0, sell: e.is_buy ? 0 : solAmt });
              if (held.flow.length > 16) held.flow.shift();
            }
          }
          if (doneMints.has(e.mint) || retiredMints.has(e.mint)) continue;
          const c = getCand(e.mint, e.creator, e.slot);
          if (c.complete) continue;
          const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          if (price <= 0) continue;
          const solAmt = Number(BigInt(e.sol_amount));
          if (Number.isNaN(c.firstPrice)) {
            c.firstPrice = price;
            c.firstSlot = e.slot;
          }
          if (price > c.high) c.high = price;
          if (e.is_buy) {
            c.buyVol += solAmt;
            if (e.user !== e.creator) {
              const v = (c.buyers.get(e.user) ?? 0) + solAmt;
              c.buyers.set(e.user, v);
              if (v > c.largestBuy) c.largestBuy = v;
            }
            c.buySinceCreatorSell += solAmt;
          } else {
            c.sellVol += solAmt;
            if (e.user === e.creator) {
              c.lastCreatorSell = solAmt;
              c.buySinceCreatorSell = 0;
            }
          }
          c.trades.push({ slot: e.slot, buy: e.is_buy, sol: solAmt, user: e.user, price });
          if (c.trades.length > 500) c.trades.splice(0, c.trades.length - 500);
          c.lastTradeSlot = e.slot;
        } else if (e.event === 'CompleteEvent') {
          const c = cands.get(e.mint);
          if (c !== undefined) c.complete = true;
        }
      }
      // Marks refresh last-trade slots for held mints.
      for (const m of batch.marks) {
        const pos = positions.get(m.mint);
        if (pos !== undefined && m.slot > pos.lastTradeSlot) pos.lastTradeSlot = m.slot;
      }

      // ---- 3. prune stale candidates (retired: never re-created) -----------
      for (const [mint, c] of cands) {
        const age = slot - c.firstSlot;
        if (!c.entered && !positions.has(mint) && !hasPendingBuy(state, mint) && (age > CONT_MAX_AGE || c.complete)) {
          cands.delete(mint);
          retiredMints.add(mint);
        }
      }

      // ---- 4. equity, drawdown, circuit breakers --------------------------
      let equity = Number(state.cash);
      for (const [mint, h] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        const p = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (p > 0) equity += Number(h.token_amount) * p;
      }
      if (equity > equityHigh) equityHigh = equity;
      const dd = equityHigh > 0 ? 1 - equity / equityHigh : 0;
      let sizeMult = 1;
      if (dd >= 0.15) stopped = true;
      else if (dd >= 0.1) sizeMult = 0;
      else if (dd >= 0.06) sizeMult = 0.5;
      else if (dd >= 0.03) sizeMult = 0.75;
      if (consecLosses >= 5) {
        pauseUntil = Math.max(pauseUntil, slot + 150);
        consecLosses = 0;
      }
      const last10 = recentOutcomes.slice(-10);
      if (last10.length === 10 && last10.filter((w) => !w).length >= 8) {
        pauseUntil = Math.max(pauseUntil, slot + 300);
        recentOutcomes = [];
      }
      if (fillOutcomes.filter((o) => o === 'fail').length >= 3) {
        pauseUntil = Math.max(pauseUntil, slot + 50);
        fillOutcomes = [];
      }
      if (pauseUntil > 0 && slot > pauseUntil) {
        pauseUntil = -1;
        halfSizeTradesLeft = 5;
      }
      const entriesPaused = stopped || sizeMult === 0 || slot <= pauseUntil;

      // ---- 5. exits (before entries and adds; urgent exits always run) -----
      // V4's plain rule: single take-profit (sell all), one stop-loss, max hold
      // (measured from the last add), no-trade exit. No trailing stop, no ladder.
      const pendingSell = new Map<string, bigint>(); // sells emitted this reply
      const soldThisReply = new Set<string>(); // mints with any sell this reply: no adds
      for (const [mint, pos] of positions) {
        const holding = state.positions.get(mint);
        if (holding === undefined) continue; // reconciled above; skip
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0 || pos.entryPrice <= 0) continue;
        if (price > pos.peak) pos.peak = price;
        const gain = price / pos.entryPrice - 1;
        const age = slot - pos.lastAddSlot; // hold clock resets on every add
        const alreadyPending = pendingSellTokens(state, mint) + (pendingSell.get(mint) ?? 0n);
        const available = holding.token_amount - alreadyPending;
        if (available <= 0n) continue;
        const fullExit =
          stopped ||
          price <= pos.entryPrice * (1 - pos.stopPct) ||
          slot - pos.lastTradeSlot >= 25 ||
          age >= pos.maxHold;
        if (fullExit) {
          orders.push({ side: 'sell', mint, token_amount: available, max_slippage_bps: SELL_SLIPPAGE_BPS });
          pendingSell.set(mint, (pendingSell.get(mint) ?? 0n) + available);
          soldThisReply.add(mint);
          continue;
        }
        if (!pos.tpDone && gain >= pos.tpPct) {
          pos.tpDone = true;
          orders.push({ side: 'sell', mint, token_amount: available, max_slippage_bps: SELL_SLIPPAGE_BPS });
          pendingSell.set(mint, (pendingSell.get(mint) ?? 0n) + available);
          soldThisReply.add(mint);
        }
      }

      // ---- 6. pyramid adds (proven runners only) ---------------------------
      // Shared budget with section 7 (entries): one exposure/cash ledger for
      // this reply, so adds + entries together cannot overspend.
      let exposureSol = 0;
      for (const pos of positions.values()) exposureSol += pos.buySol / SOL;
      exposureSol += pendingBuySol(state) / SOL;
      let freeCashSol = Number(state.freeCashLamports()) / SOL;
      if (!entriesPaused && orders.length < 16) {
        for (const [mint, pos] of positions) {
          if (orders.length >= 16) break;
          if (pos.qual) continue;
          if (soldThisReply.has(mint)) continue; // sold this reply: never add
          if (pos.adds >= MAX_ADDS) continue;
          if (slot - pos.lastAddSlot < ADD_MIN_GAP) continue;
          if (hasPendingBuy(state, mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          if (price <= 0 || pos.entryPrice <= 0) continue;
          if (price < pos.peak * ADD_NEAR_HIGH) continue; // add near the high only
          const gain = price / pos.entryPrice - 1;
          if (gain < ADD_MIN_GAIN) continue; // +100% from average entry only
          if (recentFlow(pos, slot, 10) <= 0) continue;
          let sizeSol = ADD_SIZE_SOL * sizeMult;
          if (halfSizeTradesLeft > 0) sizeSol *= 0.5;
          const capSol = Math.min(Number(state.maxBuyLamports(mint)) / SOL, 0.008 * (Number(curve.real_quote_reserves) / SOL));
          sizeSol = Math.min(sizeSol, capSol);
          sizeSol = Math.min(sizeSol, MAX_EXPOSURE_SOL - exposureSol);
          sizeSol = Math.min(sizeSol, freeCashSol - FEE_RESERVE_SOL - 0.000105);
          if (sizeSol < MIN_ORDER_SOL) continue;
          orders.push({ side: 'buy', mint, quote_lamports: lamports(sizeSol), max_slippage_bps: BUY_SLIPPAGE_BPS });
          exposureSol += sizeSol;
          freeCashSol -= sizeSol + 0.000105;
          if (halfSizeTradesLeft > 0) halfSizeTradesLeft -= 1;
        }
      }

      // ---- 7. entries ------------------------------------------------------
      if (!entriesPaused && orders.length < 16) {
        const elapsedH = ((slot - startSlot) * 0.4) / 3600;
        const paceTargets: Array<[number, number]> = [
          [2, 6],
          [4, 12],
          [8, 20],
          [12, 26],
          [16, 30],
        ];
        let target = 0;
        for (const [h, n] of paceTargets) if (elapsedH >= h) target = n;
        const behind = qualified.size < target;
        let qualMode = behind && elapsedH >= 8;
        if (elapsedH >= 20 && qualified.size < 25) qualMode = true;
        const scoreRelax = behind && elapsedH >= 2 ? 5 : 0;
        const maxPos = qualMode ? MAX_POSITIONS : MAX_NORMAL_POSITIONS;

        interface EntryPick {
          mint: string;
          score: number;
          inflow: number;
          sizeSol: number;
          qual: boolean;
        }
        const picks: EntryPick[] = [];
        for (const [mint, c] of cands) {
          if (c.entered || c.complete || doneMints.has(mint)) continue;
          if (hasPendingBuy(state, mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
          if (price <= 0 || Number.isNaN(c.firstPrice) || c.firstPrice <= 0) continue;
          const age = slot - c.firstSlot;
          const realReserveSol = Number(curve.real_quote_reserves) / SOL;
          if (realReserveSol < 3) continue;

          if (age >= MIN_AGE && age <= MAX_AGE) {
            const a = aggregate(c.trades, c.creator);
            const appreciation = price / c.firstPrice - 1;
            const score = scoreCandidate(a, appreciation, price, c.high, realReserveSol);
            const minBuyers = qualMode ? 3 : NORMAL_MIN_BUYERS;
            const minShare = qualMode ? 0.6 : 0.65;
            const minInflow = qualMode ? 0.15 * SOL : NORMAL_MIN_INFLOW_SOL * SOL;
            const threshold = (qualMode ? SCORE_QUAL : SCORE_NORMAL) - scoreRelax;
            const highThreshold = SCORE_HIGH;
            const gatesOk =
              a.buyers >= minBuyers &&
              a.buyVol + a.sellVol > 0 &&
              a.buyVol / (a.buyVol + a.sellVol) >= minShare &&
              a.netInflow >= minInflow &&
              a.firstHalfNet > 0 &&
              a.secondHalfNet > 0 &&
              a.largestShare <= NORMAL_MAX_LARGEST_SHARE &&
              a.netExLargest > 0 &&
              appreciation >= MIN_APPRECIATION &&
              appreciation <= (score >= highThreshold ? 0.45 : MAX_APPRECIATION) &&
              price >= c.high * 0.95 &&
              a.netInflow >= 0.03 * Number(curve.real_quote_reserves) &&
              creatorFilterOk(c);
            if (!gatesOk || score < threshold) continue;
            const highConv =
              score >= highThreshold &&
              a.buyers >= 7 &&
              a.buyVol / (a.buyVol + a.sellVol) >= 0.75 &&
              a.netInflow >= 0.8 * SOL &&
              a.largestShare <= 0.3 &&
              realReserveSol >= 10 &&
              price >= c.high * 0.97;
            picks.push({
              mint,
              score,
              inflow: a.netInflow,
              sizeSol: qualMode ? QUAL_SIZE_SOL : highConv ? HIGH_SIZE_SOL : NORMAL_SIZE_SOL,
              qual: qualMode,
            });
          } else if (age > MAX_AGE && age <= CONT_MAX_AGE) {
            // Continuation breakout: last-30-slot window only.
            const recent = c.trades.filter((t) => t.slot > slot - 30);
            if (recent.length < 5) continue;
            const a = aggregate(recent, c.creator);
            if (a.buyers < 5) continue;
            if (a.buyVol + a.sellVol <= 0 || a.buyVol / (a.buyVol + a.sellVol) < 0.7) continue;
            let high30 = 0;
            let low30 = Number.POSITIVE_INFINITY;
            let highBefore = 0;
            for (const t of recent) {
              if (t.price > high30) high30 = t.price;
              if (t.price < low30) low30 = t.price;
              if (t.slot < slot - 2 && t.price > highBefore) highBefore = t.price;
            }
            if (high30 <= 0 || low30 === Number.POSITIVE_INFINITY || highBefore <= 0) continue;
            if ((high30 - low30) / high30 > 0.12) continue; // consolidation too wide
            if (price < highBefore * 1.01 || price > highBefore * 1.1) continue; // breakout 1-3%+
            const prev10 = recent.filter((t) => t.slot <= slot - 10);
            const last10 = recent.filter((t) => t.slot > slot - 10);
            const buyPrev = prev10.reduce((s, t) => s + (t.buy ? t.sol : 0), 0);
            const buyLast = last10.reduce((s, t) => s + (t.buy ? t.sol : 0), 0);
            if (buyPrev > 0 && buyLast < 1.5 * buyPrev) continue;
            const breakoutStrength = low30 > 0 ? (price - low30) / low30 : 0;
            const score = scoreCandidate(a, breakoutStrength, price, high30, realReserveSol);
            if (score < SCORE_NORMAL - scoreRelax) continue;
            if (!creatorFilterOk(c)) continue;
            picks.push({ mint, score, inflow: a.netInflow, sizeSol: CONT_SIZE_SOL, qual: false });
          }
        }

        // Rank deterministically: score desc, inflow desc, mint asc.
        picks.sort((x, y) => {
          if (y.score !== x.score) return y.score - x.score;
          if (y.inflow !== x.inflow) return y.inflow - x.inflow;
          return x.mint < y.mint ? -1 : x.mint > y.mint ? 1 : 0;
        });

        let committed = state.committedPositionCount();
        for (const pick of picks) {
          if (orders.length >= 16) break;
          if (committed >= maxPos) break;
          if (committed >= MAX_POSITIONS) break;
          const curve = state.curves.get(pick.mint);
          if (curve === undefined || curve.complete) continue;
          let sizeSol = pick.sizeSol * sizeMult;
          if (halfSizeTradesLeft > 0) sizeSol *= 0.5;
          // Internal cap: 80 bps of real reserve (harness allows 100 bps).
          const capSol = Math.min(Number(state.maxBuyLamports(pick.mint)) / SOL, 0.008 * (Number(curve.real_quote_reserves) / SOL));
          sizeSol = Math.min(sizeSol, capSol);
          sizeSol = Math.min(sizeSol, MAX_EXPOSURE_SOL - exposureSol);
          sizeSol = Math.min(sizeSol, freeCashSol - FEE_RESERVE_SOL - 0.000105);
          if (sizeSol < MIN_ORDER_SOL) continue;
          orders.push({ side: 'buy', mint: pick.mint, quote_lamports: lamports(sizeSol), max_slippage_bps: BUY_SLIPPAGE_BPS });
          if (pick.qual) qualBuys.add(pick.mint);
          committed += 1;
          exposureSol += sizeSol;
          freeCashSol -= sizeSol + 0.000105;
          if (halfSizeTradesLeft > 0) halfSizeTradesLeft -= 1;
        }
      }
    } catch (err) {
      console.error(`onBatch slot ${slot} error: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
    return orders as any;
  },
  onDone(state, done) {
    const cashSol = Number(state.cash) / SOL;
    console.error(
      `done: cash=${cashSol.toFixed(4)} SOL positions=${state.positions.size} ` +
        `qualified=${qualified.size} closed=${recentOutcomes.length} wins=${recentOutcomes.filter(Boolean).length}`,
    );
  },
});
