// Burst Rider — a cbBTC/USDC bot for the agent-fun/bars-replay/v1 harness.
//
// The idea in plain words: cbBTC spends most minutes drifting sideways, and
// a round trip through the pool costs roughly a quarter of a percent once
// the fee, the modelled slippage and my own price impact are added up.
// Chasing every wiggle therefore bleeds money. Instead this bot waits for
// a genuine burst — a climb of at least one percent stretched over the
// last thirty one-minute bars — and only then puts most of its cash to
// work. While it holds, a trailing stop watches the position: the stop
// stays dormant until the trade is at least 0.3% in profit, and from
// there any fall of 0.3% below the best close seen since entry closes
// the trade. After an exit the bot rests through a long cooldown, so a
// single burst cannot be bought over and over on the way down.
//
// Every threshold below is tested with cross-multiplied bigints, never
// floats, so the same stream of hello, batch and orders always produces
// byte-identical replies: "up at least x percent" becomes the exact
// integer identity now * DEN >= then * (DEN + x).
//
// The wire protocol itself — hello once, one batch per closed bar,
// exactly one reply of orders per batch, fills landing at the next bar's
// open — is handled by the vendored shim; this file only picks orders.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

// ---- the knobs of the strategy, named for what they do -------------------

/** Bars of history a burst is measured over (the build window). */
const BUILD_BARS = 30;
/** A burst counts only when the close gained at least this many bps over the build window: 100 bps = 1.00%. */
const BURST_GAIN_BPS = 100n;
/** Share of the cash pile a single entry may spend: 90 of every 100 units. */
const ENTRY_SHARE_NUM = 90n;
const ENTRY_SHARE_DEN = 100n;
/** Gain over the entry price, in thousandths, that arms the trailing stop: 3 = +0.3%. */
const TRAIL_ARM_PARTS = 3n;
/** Fall from the running peak, in thousandths, that exits once the stop is armed: 3 = 0.3%. */
const TRAIL_DROP_PARTS = 3n;
/**
 * Hard stop, in thousandths below the entry price: 5 = -0.5%. The trailing
 * stop only arms after a gain, so without this a burst that reverses at
 * once would be ridden all the way to the end-of-window flatten; the hard
 * stop cuts that case short.
 */
const HARD_STOP_PARTS = 5n;
/** Parts-per-thousand denominator shared by the two trailing thresholds. */
const PARTS_DEN = 1_000n;
/** Bars to stay flat after an exit before a new burst may be taken. */
const REST_BARS = 90;
/** Slippage cap sent with every order; wide on purpose, the signal is a fast move. */
const SLIP_CAP_BPS = 10_000;

// ---- run state ------------------------------------------------------------

/** Every close seen for the traded symbol this run, oldest first. */
const closesSeen: bigint[] = [];
/** Seq of the batch on which the open position was first observed; -1 while flat. */
let entrySeq = -1;
/** Effective entry price (position cost per unit, price-scale units) of the open trade. */
let entryPrice: bigint | null = null;
/** Highest close observed since the position appeared. */
let peakSinceEntry: bigint | null = null;
/** True once price has cleared entry + arm threshold; never un-arms within a trade. */
let trailArmed = false;
/** Whether the previous batch still held the position, to spot the exit bar. */
let wasHolding = false;
/** First seq at which a fresh entry is allowed again; 0 means no cooldown is running. */
let restUntilSeq = 0;
/** Guards against sending a second sell while the first is still travelling to its fill. */
let exitPending = false;

// ---- helpers ---------------------------------------------------------------

/** The symbol this race trades: the first (and only) entry of the hello universe. */
function tradedSymbol(state: BarsState): string {
  return state.hello.symbols[0]!.symbol;
}

/**
 * Recover the per-unit price the open position was filled at, in price
 * units, from the account's own bookkeeping. cost_quote_units is what the
 * fills charged in total (fees included) and qty sits at qty scale, while
 * a price p means p / 10^price_scale USDC per whole unit, so:
 *   price = cost * 10^(qty_scale + price_scale) / (qty * 10^quote_scale).
 * Anchoring the trailing stop to the charged cost — not to the close of
 * the bar that decided the buy — keeps its maths honest about the fill.
 */
function impliedEntryPrice(state: BarsState, symbol: string): bigint | null {
  const held = state.positions.get(symbol);
  const info = state.symbols.get(symbol);
  if (held === undefined || info === undefined || held.qty === 0n) return null;
  const scaled = held.cost * 10n ** BigInt(info.qty_scale + info.price_scale);
  return scaled / (held.qty * 10n ** BigInt(state.hello.capital.quote_scale));
}

/** True when the latest close gained at least BURST_GAIN_BPS over the close BUILD_BARS earlier. */
function burstConfirmed(latest: bigint): boolean {
  if (closesSeen.length <= BUILD_BARS) return false;
  const earlier = closesSeen[closesSeen.length - 1 - BUILD_BARS]!;
  return latest * 10_000n >= earlier * (10_000n + BURST_GAIN_BPS);
}

// ---- the decision loop ------------------------------------------------------

await runBars({
  onBatch(state, batch): OrderInput[] {
    const symbol = tradedSymbol(state);
    const closeNow = state.close(symbol);

    // A batch without our symbol's bar teaches nothing and changes nothing.
    if (closeNow === null) return [];
    closesSeen.push(closeNow);

    const held = state.positions.get(symbol);
    const holding = held !== undefined && held.qty > 0n;

    // Spot the bar where a position appears: stamp the trade's anchors.
    if (holding && !wasHolding) {
      entrySeq = batch.seq;
      entryPrice = impliedEntryPrice(state, symbol);
      peakSinceEntry = closeNow;
      trailArmed = false;
      exitPending = false;
    }
    // Spot the bar where it vanished: the rest window starts counting here.
    if (!holding && wasHolding) {
      restUntilSeq = batch.seq + REST_BARS;
      entrySeq = -1;
      entryPrice = null;
      peakSinceEntry = null;
      trailArmed = false;
      exitPending = false;
    }
    wasHolding = holding;

    // Warm-up batches build history only; the harness rejects their orders.
    if (state.warmingUp) return [];

    // --- holding: only one question, whether the trailing stop says sell.
    if (holding) {
      if (peakSinceEntry === null || closeNow > peakSinceEntry) peakSinceEntry = closeNow;
      if (entryPrice === null || peakSinceEntry === null) return [];
      // The hard stop is checked first: it needs no arming and overrides the trail.
      const hardStopTripped = closeNow * PARTS_DEN <= entryPrice * (PARTS_DEN - HARD_STOP_PARTS);
      if (hardStopTripped && !exitPending) {
        exitPending = true;
        return [{ side: 'sell', symbol, qty: held!.qty, max_slippage_bps: SLIP_CAP_BPS }];
      }
      if (!trailArmed && closeNow * PARTS_DEN >= entryPrice * (PARTS_DEN + TRAIL_ARM_PARTS)) {
        trailArmed = true;
      }
      const stopTripped = trailArmed && closeNow * PARTS_DEN <= peakSinceEntry * (PARTS_DEN - TRAIL_DROP_PARTS);
      if (stopTripped && !exitPending) {
        exitPending = true;
        return [{ side: 'sell', symbol, qty: held!.qty, max_slippage_bps: SLIP_CAP_BPS }];
      }
      return [];
    }

    // --- flat: rest through the cooldown, then wait for the next burst.
    if (batch.seq < restUntilSeq) return [];
    if (!burstConfirmed(closeNow)) return [];

    let spend = (state.cash * ENTRY_SHARE_NUM) / ENTRY_SHARE_DEN;
    const room = state.weightRoom(symbol);
    if (spend > room) spend = room;
    if (spend < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: SLIP_CAP_BPS }];
  },
});
