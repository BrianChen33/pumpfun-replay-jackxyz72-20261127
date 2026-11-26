// Pump.fun Replay Sprint — paper trading bot (hand-written by Muse, 2026-11-27 session).
//
// Strategy (GPT-6.2 High advised the design only; no ChatGPT-written code is used here).
//
// V8 — V4's base (dev +0.018 SOL, 91 round trips, 34% win rate) with the
// one-time GPT review's fixes applied. No strategy overhaul: the review's
// verdict was FIX FIRST, then submit.
//
// What the review found, and what this version does about it (verified against
// the kit's harness source, sim/engine.ts + contracts/protocol.ts, not taken
// on trust):
//  - TP could never retry after a failed/rejected sell: tpDone was set when
//    the order was EMITTED. Removed tpDone; a pending sell blocks duplicates
//    via the harness pending set, and a failed/rejected sell simply re-fires
//    next reply. (P0 #1)
//  - qualBuys was never cleaned on a failed/rejected buy, so a later normal
//    buy on the same mint could inherit qual exits. The qual flag is now set
//    explicitly on every buy order, and cleared on any failed/rejected fill.
//    (P0 #2)
//  - Qualification heuristic was wrong (50% sold). The official rule is:
//    a round trip counts when the position closes FOR ANY REASON (sell,
//    _complete, _flatten, _writeoff all close it) with bought_lamports
//    (sum of buy fills' quote_lamports, tx fees excluded) >= 0.01 SOL.
//    The local mirror is now exactly that: close + buyQuote >= 0.01 SOL.
//    (P0 #3)
//  - state.positions is the POST-fill account snapshot, so two sell fills for
//    one mint in a batch could close the local book before the second was
//    counted. Fills are now all applied first, positions closed once per mint
//    afterwards. (P0 #4)
//  - _complete/_flatten/_writeoff: no special-casing needed for closing (the
//    position is gone from the account either way); fees are taken from each
//    fill's own tx_fee_lamports, so a writeoff (quote 0, tx fee 0) is handled
//    correctly. (P0 #5/#6)
//  - Entered candidates were never pruned (Cand + trades + buyers Map kept
//    forever). The Cand is deleted on the buy fill; doneMints still blocks
//    re-entry. (P0 #7)
//  - Fee accounting: buy quote_lamports INCLUDES curve fees, sell quote is
//    NET of curve fees, and the 105,000-lamport tx fee is separate (paid on
//    filled AND failed orders, not on rejections). Local PnL now uses
//    buy cost = quote + txFee, sell proceeds = quote - txFee, from each
//    fill's own tx_fee_lamports. (P1 #9/#10)
//  - Creator concentration was diluted by creator buys (they inflated the
//    largest-share denominator): largestShare is now computed on NON-creator
//    buy volume, with a creator-buy-share gate (<= 40%). Creator selling is
//    tracked as an unabsorbed balance (cumulative sells minus subsequent
//    non-creator buys), not just the last sell. (strategy #26/#27)
//  - Freshness: primary/continuation entries require a real trade within the
//    last 3 slots (the two-half flow split used first/last trade slots and
//    could admit stale momentum). (strategy #30)
//  - The +45% run-up allowance now requires the FULL high-conviction set,
//    not just score >= 80. (strategy #31)
//  - Trailing stop: once a position's peak gain reaches +20%, a 15%
//    retracement from the peak exits. Momentum-failure exit: 20+ slots held,
//    gain <= +3%, recent 10-slot net flow negative. (strategy #39/#40)
//  - Qual trades can no longer be starved by size reductions: qual size is
//    floored at the 0.025 SOL minimum order. Pacing counts open positions
//    (buyQuote >= 0.01 SOL) as well as confirmed ones, and the pace table is
//    steeper. (P1 #20/#23, strategy #22)
//  - Dead code removed: the disabled pyramid branch (MAX_ADDS = 0), tpDone,
//    the redundant per-candidate running totals (aggregate() recomputes from
//    trades), and unused fields. onDone now reports global totals, not the
//    30-item rolling window. Buy amounts use Math.floor (never round up past
//    a cap). (code quality #75/#76/#78/#80)
//
// Verified against the harness source and deliberately NOT changed:
//  - Marks carry the last REAL trade slot (m.stateSlot, set only on
//    Create/Trade events), so the no-trade exit is sound. (#42)
//  - The bot's own fills never appear in the recorded event stream, so
//    scoring cannot be contaminated by self-trades. (#71)
//  - Holding.token_amount is the TOTAL held (pending sells are not deducted),
//    so subtracting pending sells is correct, not double-counting. (#16)
//  - max_order_size is checked per mint per reply at DECISION-time reserves,
//    so a later reserve drop cannot retroactively reject. (#14)
//  - After the 15% capital stop, a buy that still fills is sold in the SAME
//    reply's exit pass (fills are processed before exits). (#53)
//  - A mint whose first trade arrives > 250 slots after creation is no longer
//    pruned before its first trade. (#60)
//
// Determinism: no clock, no environment, no Math.random. All decisions derive
// from the replay stream (slots, events, fills). Candidate ranking uses explicit
// deterministic tie-breaks (score, inflow, mint address), and the bot is executed
// twice with byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- constants
const SOL = 1_000_000_000; // lamports per SOL, as a JS number (amounts stay < 2^53)
const MIN_AGE = 5; // primary entry window, slots since first trade
const MAX_AGE = 18;
const CONT_MAX_AGE = 250; // continuation window
const NORMAL_SIZE_SOL = 0.08;
const HIGH_SIZE_SOL = 0.2;
const CONT_SIZE_SOL = 0.12;
const QUAL_SIZE_SOL = 0.03;
const MIN_ORDER_SOL = 0.025; // below this, fixed fees eat the trade
const MIN_RESERVE_SOL = 3.125; // 0.8% of this is exactly MIN_ORDER_SOL
const MAX_EXPOSURE_SOL = 1.0; // hard initial-exposure cap (buy-cost basis)
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
const CREATOR_MAX_SHARE = 0.4; // creator buys may be at most 40% of buy volume
const CREATOR_SELL_TOLERANCE_SOL = 0.05; // unabsorbed creator selling allowed
const FRESHNESS_SLOTS = 3; // last real trade must be this recent to enter
const MIN_APPRECIATION = 0.08;
const MAX_APPRECIATION = 0.3;
const BUY_SLIPPAGE_BPS = 1000;
const TP_SLIPPAGE_BPS = 800; // take-profit: tighter, a rejection just retries
const SELL_SLIPPAGE_BPS = 2000; // stop / emergency / time exits: get out
const TRAIL_ACTIVATE_GAIN = 0.2; // trailing stop arms at +20% peak gain
const TRAIL_RETREAT = 0.15; // ... then exits on a 15% retracement from peak
const MOMENTUM_FAIL_AGE = 20; // momentum-failure exit: held this long...
const MOMENTUM_FAIL_GAIN = 0.03; // ... up no more than this...
const MAX_NORMAL_POSITIONS = 3;
const MAX_POSITIONS = 5;
const MIN_BUY_LAMPORTS_QUAL = 10_000_000; // 0.01 SOL guardrail round trip

// Floor, never round up: a buy amount must never exceed the cap it was sized against.
const lamports = (sol: number): bigint => BigInt(Math.floor(sol * SOL));

// ---------------------------------------------------------------- per-mint candidate state
interface TradeRec {
  slot: number;
  buy: boolean;
  sol: number; // lamports, as a number
  user: string;
  price: number; // virtual quote / virtual token at this trade
}

interface Cand {
  creator: string;
  firstSlot: number;
  firstPrice: number; // NaN until the first trade
  high: number;
  creatorSellUnabsorbed: number; // lamports of creator selling not yet absorbed by non-creator buys
  trades: TradeRec[];
  lastTradeSlot: number;
  complete: boolean;
}

// ---------------------------------------------------------------- position state
interface FlowBucket {
  slot: number;
  buy: number;
  sell: number;
}

interface Pos {
  entryPrice: number; // volume-weighted average entry, lamports per token base unit
  entrySlot: number;
  tokensBought: bigint;
  tokensSold: bigint;
  buySol: number; // lamports spent incl. curve fees AND tx fees (local PnL basis)
  buyQuote: number; // lamports of buy fills' quote only (official round-trip basis)
  sellSol: number; // lamports received net of curve fees AND tx fees
  peak: number; // max price since entry
  lastTradeSlot: number;
  flow: FlowBucket[]; // recent per-slot flow, capped
  qual: boolean; // qualification-mode trade: single small TP, tighter stop/hold
  stopPct: number;
  tpPct: number;
  maxHold: number; // slots, measured from entrySlot
}

// ---------------------------------------------------------------- run state
let startSlot: number | null = null;
const cands = new Map<string, Cand>();
const positions = new Map<string, Pos>();
const doneMints = new Set<string>(); // entered once: never re-enter
const retiredMints = new Set<string>(); // aged out of every window: never re-created
const completedMints = new Set<string>(); // saw a CompleteEvent: never re-created
const qualified = new Set<string>(); // confirmed round-tripping mints (official rule mirror)
let recentOutcomes: boolean[] = []; // win = true, per closed round trip (cap 30, circuit breakers only)
let consecLosses = 0;
let fillOutcomes: Array<'ok' | 'fail'> = []; // last 20 of MY orders' outcomes
let pauseUntil = -1;
let halfSizeTradesLeft = 0;
let equityHigh = 10 * SOL; // lamports
let stopped = false; // capital preservation: DD >= 15%
const qualBuys = new Set<string>(); // mints whose most recent buy order was a qual order
// Global totals for onDone (recentOutcomes is a capped rolling window, not a total).
let totalClosed = 0;
let totalWins = 0;
let totalFailedOrders = 0;
let totalRejectedOrders = 0;
let totalTxFeesLamports = 0;
let totalWriteoffs = 0;
let totalHarnessCloses = 0;

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n || vq < 0n) return 0;
  const p = Number(vq) / Number(vt);
  return Number.isFinite(p) && p > 0 ? p : 0;
}

function getCand(mint: string, creator: string, slot: number): Cand {
  let c = cands.get(mint);
  if (c === undefined) {
    c = {
      creator,
      firstSlot: slot,
      firstPrice: NaN,
      high: 0,
      creatorSellUnabsorbed: 0,
      trades: [],
      lastTradeSlot: slot,
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
  largestShare: number; // largest non-creator buyer share of NON-creator buy volume, 0..1
  creatorShare: number; // creator buys share of total buy volume, 0..1
  netInflow: number; // lamports, all buyers
  netExLargest: number; // non-creator inflow excluding the largest buyer, lamports
  firstHalfNet: number;
  secondHalfNet: number;
}

function aggregate(trades: TradeRec[], creator: string): Agg {
  let buyVol = 0;
  let sellVol = 0;
  let creatorBuy = 0;
  let nonCreatorBuyVol = 0;
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
        if (t.user === creator) {
          creatorBuy += t.sol;
        } else {
          nonCreatorBuyVol += t.sol;
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
    largestShare: nonCreatorBuyVol > 0 ? largestBuy / nonCreatorBuyVol : 0,
    creatorShare: buyVol > 0 ? creatorBuy / buyVol : 0,
    netInflow,
    netExLargest: nonCreatorBuyVol - sellVol - largestBuy,
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
  return c.creatorSellUnabsorbed < CREATOR_SELL_TOLERANCE_SOL * SOL;
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
  // Official round-trip mirror: the position closed (any reason) and its buy
  // fills' quote alone reached 0.01 SOL. Sell proceeds do not enter the rule.
  if (pos.buyQuote >= MIN_BUY_LAMPORTS_QUAL) {
    qualified.add(mint);
  }
  totalClosed += 1;
  if (won) totalWins += 1;
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
      // Pass 1: apply EVERY fill in this batch before closing anything.
      // state.positions is the POST-fill snapshot, so closing on the first
      // sell fill would drop the second fill's accounting.
      const touched = new Set<string>(); // mints with a sell fill this batch
      for (const f of batch.fills) {
        const isMine = typeof f.client_id === 'string' && !f.client_id.startsWith('_');
        if (f.status === 'failed') {
          if (isMine) {
            fillOutcomes.push('fail');
            if (fillOutcomes.length > 20) fillOutcomes.shift();
            totalFailedOrders += 1;
            totalTxFeesLamports += Number(BigInt(f.tx_fee_lamports ?? '0'));
          }
          qualBuys.delete(f.mint);
          continue;
        }
        if (f.status === 'rejected') {
          if (isMine) totalRejectedOrders += 1;
          qualBuys.delete(f.mint);
          continue;
        }
        if (f.status !== 'filled') {
          console.error(`unknown fill status ${String(f.status)} for ${f.mint}`);
          if (isMine) {
            fillOutcomes.push('fail');
            if (fillOutcomes.length > 20) fillOutcomes.shift();
          }
          qualBuys.delete(f.mint);
          continue;
        }
        // filled
        if (isMine) {
          fillOutcomes.push('ok');
          if (fillOutcomes.length > 20) fillOutcomes.shift();
        }
        const mint = f.mint;
        const quote = Number(BigInt(f.quote_lamports));
        const txFee = Number(BigInt(f.tx_fee_lamports ?? '0'));
        if (f.side === 'buy') {
          const tokens = BigInt(f.token_amount);
          if (tokens === 0n) continue;
          totalTxFeesLamports += txFee;
          let pos = positions.get(mint);
          const entryPrice = quote / Number(tokens);
          if (pos === undefined) {
            const isQual = qualBuys.has(mint);
            qualBuys.delete(mint);
            pos = {
              entryPrice,
              entrySlot: slot,
              tokensBought: tokens,
              tokensSold: 0n,
              buySol: quote + txFee,
              buyQuote: quote,
              sellSol: 0,
              peak: entryPrice,
              lastTradeSlot: slot,
              flow: [],
              qual: isQual,
              stopPct: isQual ? QUAL_STOP_PCT : STOP_PCT,
              tpPct: isQual ? QUAL_TP_PCT : TP_PCT,
              maxHold: isQual ? QUAL_MAX_HOLD : MAX_HOLD_SLOTS,
            };
            positions.set(mint, pos);
          } else {
            // Should not happen with adds disabled; re-average defensively.
            const totalTokens = pos.tokensBought + tokens;
            pos.entryPrice = (pos.entryPrice * Number(pos.tokensBought) + entryPrice * Number(tokens)) / Number(totalTokens);
            pos.tokensBought = totalTokens;
            pos.buySol += quote + txFee;
            pos.buyQuote += quote;
          }
          // The candidate is spent: free its history. doneMints blocks re-entry.
          cands.delete(mint);
          doneMints.add(mint);
          if (halfSizeTradesLeft > 0) halfSizeTradesLeft -= 1;
        } else {
          // sell fill: ours, or a harness close (_complete/_flatten/_writeoff).
          // A writeoff pays nothing (quote 0, tx fee 0); the others pay proceeds
          // minus the tx fee, exactly as the fill reports.
          const pos = positions.get(mint);
          if (pos === undefined) continue;
          pos.tokensSold += BigInt(f.token_amount);
          pos.sellSol += Math.max(0, quote - txFee);
          totalTxFeesLamports += txFee;
          touched.add(mint);
          if (!isMine) {
            if (typeof f.client_id === 'string' && f.client_id.startsWith('_writeoff')) totalWriteoffs += 1;
            else totalHarnessCloses += 1;
          }
        }
      }
      // Pass 2: close, once per mint, the positions the harness no longer holds.
      for (const mint of touched) {
        if (!state.positions.has(mint)) {
          const pos = positions.get(mint);
          if (pos !== undefined) closePosition(mint, pos.sellSol > pos.buySol);
        }
      }
      // Pass 3: reconcile local positions the harness no longer holds with no
      // fill seen in this batch (defensive; the harness always sends a fill).
      for (const mint of [...positions.keys()]) {
        if (!state.positions.has(mint)) {
          const pos = positions.get(mint)!;
          closePosition(mint, pos.sellSol > pos.buySol);
        }
      }
      // Pass 4: adopt orphan positions (harness holds something we do not
      // track) at cost basis, so they are managed instead of stranded. The
      // harness flattens any remainder at the end of the window regardless.
      for (const [mint, holding] of state.positions) {
        if (positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        const tokens = BigInt(holding.token_amount);
        const cost = Number(BigInt(holding.cost_lamports ?? '0'));
        let entryPrice = tokens > 0n && cost > 0 ? cost / Number(tokens) : 0;
        if (entryPrice <= 0 && curve !== undefined) {
          entryPrice = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        }
        if (entryPrice <= 0) continue;
        console.error(`orphan position ${mint}: adopting at cost basis`);
        positions.set(mint, {
          entryPrice,
          entrySlot: slot,
          tokensBought: tokens,
          tokensSold: 0n,
          buySol: cost,
          buyQuote: cost,
          sellSol: 0,
          peak: entryPrice,
          lastTradeSlot: slot,
          flow: [],
          qual: false,
          stopPct: STOP_PCT,
          tpPct: TP_PCT,
          maxHold: MAX_HOLD_SLOTS,
        });
        doneMints.add(mint);
      }

      // ---- 2. fold events into candidate / position state -----------------
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          if (!doneMints.has(e.mint) && !retiredMints.has(e.mint) && !completedMints.has(e.mint) && !cands.has(e.mint)) {
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
          if (doneMints.has(e.mint) || retiredMints.has(e.mint) || completedMints.has(e.mint)) continue;
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
          // Creator selling is tracked as an unabsorbed balance: creator sells
          // add to it, non-creator buys absorb it (floored at zero). Creator
          // buys do not count as absorption.
          if (e.user === c.creator) {
            if (e.is_buy) {
              // creator buy: no effect on the unabsorbed balance
            } else {
              c.creatorSellUnabsorbed += solAmt;
            }
          } else if (e.is_buy) {
            c.creatorSellUnabsorbed = Math.max(0, c.creatorSellUnabsorbed - solAmt);
          }
          c.trades.push({ slot: e.slot, buy: e.is_buy, sol: solAmt, user: e.user, price });
          if (c.trades.length > 500) c.trades.splice(0, c.trades.length - 500);
          c.lastTradeSlot = e.slot;
        } else if (e.event === 'CompleteEvent') {
          completedMints.add(e.mint);
          const c = cands.get(e.mint);
          if (c !== undefined) c.complete = true;
        }
      }
      // Marks carry the slot of the last real trade for the mint (harness
      // stateSlot), never a refresh timestamp, so they are safe here.
      for (const m of batch.marks) {
        const pos = positions.get(m.mint);
        if (pos !== undefined && m.slot > pos.lastTradeSlot) pos.lastTradeSlot = m.slot;
      }

      // ---- 3. prune stale candidates (retired: never re-created) -----------
      // A candidate that has not traded yet is never pruned: its age is measured
      // from its first trade, not its creation.
      for (const [mint, c] of cands) {
        if (Number.isNaN(c.firstPrice)) continue;
        const age = slot - c.firstSlot;
        if (!positions.has(mint) && !hasPendingBuy(state, mint) && (age > CONT_MAX_AGE || c.complete)) {
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

      // ---- 5. exits (before entries; urgent exits always run) ---------------
      // Single take-profit (sell all), one stop-loss, max hold, no-trade exit,
      // plus a trailing stop (arms at +20% peak gain, 15% retracement) and a
      // momentum-failure exit (20+ slots, <= +3%, recent flow negative).
      // A failed/rejected TP sell simply re-fires next reply: there is no
      // tpDone flag, and a pending sell leaves zero tokens available.
      for (const [mint, pos] of positions) {
        const holding = state.positions.get(mint);
        if (holding === undefined) continue; // reconciled above; skip
        const curve = state.curves.get(mint);
        const price = curve === undefined ? 0 : priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const curveGone = curve === undefined || curve.complete;
        const age = slot - pos.entrySlot;
        const alreadyPending = pendingSellTokens(state, mint);
        const available = holding.token_amount - alreadyPending;
        if (available <= 0n) continue;
        if (price > 0 && price > pos.peak) pos.peak = price;
        const gain = price > 0 && pos.entryPrice > 0 ? price / pos.entryPrice - 1 : 0;
        const peakGain = pos.entryPrice > 0 ? pos.peak / pos.entryPrice - 1 : 0;
        const trailing =
          price > 0 && peakGain >= TRAIL_ACTIVATE_GAIN && price <= pos.peak * (1 - TRAIL_RETREAT);
        const momentumFail =
          price > 0 && age >= MOMENTUM_FAIL_AGE && gain <= MOMENTUM_FAIL_GAIN && recentFlow(pos, slot, 10) < 0;
        const fullExit =
          stopped ||
          (price > 0 && price <= pos.entryPrice * (1 - pos.stopPct)) ||
          slot - pos.lastTradeSlot >= 25 ||
          age >= pos.maxHold ||
          trailing ||
          momentumFail;
        if (fullExit) {
          // Time-based exits fire even when the curve is gone/unpriced; the
          // harness prices the sell from its own reserves at fill time.
          orders.push({ side: 'sell', mint, token_amount: available, max_slippage_bps: SELL_SLIPPAGE_BPS });
          continue;
        }
        if (curveGone || price <= 0) continue; // cannot evaluate a TP without a price
        if (gain >= pos.tpPct) {
          orders.push({ side: 'sell', mint, token_amount: available, max_slippage_bps: TP_SLIPPAGE_BPS });
        }
      }

      // ---- 6. entries ------------------------------------------------------
      if (!entriesPaused && orders.length < 16) {
        // No free slot: skip the whole scoring pass.
        if (state.committedPositionCount() >= MAX_POSITIONS) {
          // fall through to returning the exit orders only
        } else {
          const elapsedH = ((slot - startSlot) * 0.4) / 3600;
          // Open positions already bought >= 0.01 SOL will count when they
          // close (any reason), so they count toward the pace target now.
          let inFlight = 0;
          for (const pos of positions.values()) {
            if (pos.buyQuote >= MIN_BUY_LAMPORTS_QUAL) inFlight += 1;
          }
          const paceCount = qualified.size + inFlight;
          const paceTargets: Array<[number, number]> = [
            [2, 6],
            [4, 12],
            [6, 18],
            [8, 24],
            [12, 30],
            [16, 30],
          ];
          let target = 0;
          for (const [h, n] of paceTargets) if (elapsedH >= h) target = n;
          const behind = paceCount < target;
          let qualMode = behind && elapsedH >= 6;
          if (elapsedH >= 20 && paceCount < 25) qualMode = true;
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
            if (c.complete || doneMints.has(mint)) continue;
            if (hasPendingBuy(state, mint)) continue;
            if (slot - c.lastTradeSlot > FRESHNESS_SLOTS) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
            if (price <= 0 || Number.isNaN(c.firstPrice) || c.firstPrice <= 0) continue;
            const age = slot - c.firstSlot;
            const realReserveSol = Number(curve.real_quote_reserves) / SOL;
            if (realReserveSol < MIN_RESERVE_SOL) continue;

            if (age >= MIN_AGE && age <= MAX_AGE) {
              const a = aggregate(c.trades, c.creator);
              const appreciation = price / c.firstPrice - 1;
              const score = scoreCandidate(a, appreciation, price, c.high, realReserveSol);
              const highConv =
                score >= SCORE_HIGH &&
                a.buyers >= 7 &&
                a.buyVol + a.sellVol > 0 &&
                a.buyVol / (a.buyVol + a.sellVol) >= 0.75 &&
                a.netInflow >= 0.8 * SOL &&
                a.largestShare <= 0.3 &&
                realReserveSol >= 10 &&
                price >= c.high * 0.97;
              const minBuyers = qualMode ? 3 : NORMAL_MIN_BUYERS;
              const minShare = qualMode ? 0.6 : 0.65;
              const minInflow = qualMode ? 0.15 * SOL : NORMAL_MIN_INFLOW_SOL * SOL;
              const threshold = (qualMode ? SCORE_QUAL : SCORE_NORMAL) - scoreRelax;
              const gatesOk =
                a.buyers >= minBuyers &&
                a.buyVol + a.sellVol > 0 &&
                a.buyVol / (a.buyVol + a.sellVol) >= minShare &&
                a.netInflow >= minInflow &&
                a.firstHalfNet > 0 &&
                a.secondHalfNet > 0 &&
                a.largestShare <= NORMAL_MAX_LARGEST_SHARE &&
                a.creatorShare <= CREATOR_MAX_SHARE &&
                a.netExLargest > 0 &&
                appreciation >= MIN_APPRECIATION &&
                appreciation <= (highConv ? 0.45 : MAX_APPRECIATION) &&
                price >= c.high * 0.95 &&
                a.netInflow >= 0.03 * Number(curve.real_quote_reserves) &&
                creatorFilterOk(c);
              if (!gatesOk || score < threshold) continue;
              picks.push({
                mint,
                score,
                inflow: a.netInflow,
                sizeSol: qualMode ? QUAL_SIZE_SOL : highConv ? HIGH_SIZE_SOL : NORMAL_SIZE_SOL,
                qual: qualMode,
              });
            } else if (age > MAX_AGE && age <= CONT_MAX_AGE) {
              // Continuation breakout: last-30-slot window only, with equal
              // 10-slot windows for the acceleration check.
              const recent = c.trades.filter((t) => t.slot > slot - 30);
              if (recent.length < 5) continue;
              const a = aggregate(recent, c.creator);
              if (a.buyers < 5) continue;
              if (a.buyVol + a.sellVol <= 0 || a.buyVol / (a.buyVol + a.sellVol) < 0.7) continue;
              if (a.largestShare > NORMAL_MAX_LARGEST_SHARE) continue;
              if (a.creatorShare > CREATOR_MAX_SHARE) continue;
              if (a.netExLargest <= 0) continue;
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
              if (price < highBefore * 1.01 || price > highBefore * 1.1) continue; // breakout 1-10% above prior high
              const prevWin = recent.filter((t) => t.slot > slot - 20 && t.slot <= slot - 10);
              const lastWin = recent.filter((t) => t.slot > slot - 10);
              const buyPrev = prevWin.reduce((s, t) => s + (t.buy ? t.sol : 0), 0);
              const buyLast = lastWin.reduce((s, t) => s + (t.buy ? t.sol : 0), 0);
              if (buyPrev > 0 && buyLast < 1.5 * buyPrev) continue;
              if (buyPrev === 0 && buyLast < 0.05 * SOL) continue;
              const breakoutStrength = low30 > 0 ? (price - low30) / low30 : 0;
              const score = scoreCandidate(a, breakoutStrength, price, high30, realReserveSol);
              if (score < SCORE_NORMAL - scoreRelax) continue;
              if (!creatorFilterOk(c)) continue;
              picks.push({ mint, score, inflow: a.netInflow, sizeSol: qualMode ? QUAL_SIZE_SOL : CONT_SIZE_SOL, qual: qualMode });
            }
          }

          // Rank deterministically: score desc, inflow desc, mint asc.
          picks.sort((x, y) => {
            if (y.score !== x.score) return y.score - x.score;
            if (y.inflow !== x.inflow) return y.inflow - x.inflow;
            return x.mint < y.mint ? -1 : x.mint > y.mint ? 1 : 0;
          });

          let exposureSol = 0;
          for (const pos of positions.values()) exposureSol += pos.buySol / SOL;
          exposureSol += pendingBuySol(state) / SOL;
          let freeCashSol = Number(state.freeCashLamports()) / SOL;
          let committed = state.committedPositionCount();
          for (const pick of picks) {
            if (orders.length >= 16) break;
            if (committed >= maxPos) break;
            if (committed >= MAX_POSITIONS) break;
            const curve = state.curves.get(pick.mint);
            if (curve === undefined || curve.complete) continue;
            let sizeSol = pick.sizeSol * sizeMult;
            if (halfSizeTradesLeft > 0) sizeSol *= 0.5;
            // A qual trade must never be sized below the minimum order by a
            // risk reduction; it is either a real 0.025+ SOL order or nothing.
            if (pick.qual) sizeSol = Math.max(sizeSol, MIN_ORDER_SOL);
            // Internal cap: 80 bps of real reserve (harness allows 100 bps).
            const capSol = Math.min(Number(state.maxBuyLamports(pick.mint)) / SOL, 0.008 * (Number(curve.real_quote_reserves) / SOL));
            sizeSol = Math.min(sizeSol, capSol);
            sizeSol = Math.min(sizeSol, MAX_EXPOSURE_SOL - exposureSol);
            sizeSol = Math.min(sizeSol, freeCashSol - FEE_RESERVE_SOL - 0.000105);
            if (sizeSol < MIN_ORDER_SOL) continue;
            orders.push({ side: 'buy', mint: pick.mint, quote_lamports: lamports(sizeSol), max_slippage_bps: BUY_SLIPPAGE_BPS });
            // Bind the qual flag to THIS order: the most recent buy order's
            // mode wins, so a failed qual buy cannot mislabel a later retry.
            if (pick.qual) qualBuys.add(pick.mint);
            else qualBuys.delete(pick.mint);
            committed += 1;
            exposureSol += sizeSol;
            freeCashSol -= sizeSol + 0.000105;
          }
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
        `qualified=${qualified.size} closed=${totalClosed} wins=${totalWins} ` +
        `failed_orders=${totalFailedOrders} rejected_orders=${totalRejectedOrders} ` +
        `writeoffs=${totalWriteoffs} harness_closes=${totalHarnessCloses} ` +
        `tx_fees=${(totalTxFeesLamports / SOL).toFixed(4)} SOL`,
    );
  },
});
