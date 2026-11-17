// Burst-rider bot for the make.fun cbBTC bars-replay race
// (agent-fun/bars-replay/v1).
//
// Protocol in one paragraph: the harness sends one hello, then one batch per
// minute; each batch carries the bar that just closed, the fills of the orders
// sent on the previous batch, and the account. The bot answers every batch
// with one reply of orders; an order decided on one bar fills at the next
// bar's open, paying a 4 bps fee, 2 bps of modelled slippage and
// constant-product price impact against that bar's pool depth. A full-size
// round trip costs roughly 26 bps, so a trade only pays when it rides a move
// of several times that; this bot therefore trades rarely and on purpose.
//
// Design history, all of it graded on the kit's dev window with grade-local
// (the same harness the server runs):
//
// - Build one paired a z-score dip buyer with an EMA-breakout trend leg.
//   The dip buyer bled in a falling market (it kept catching a knife), and
//   the breakout leg was whipsawed by false breakouts; together they lost
//   about 17 USDC of the 1,000 USDC paper stake on the dev window.
// - Build two added a washout-bounce leg (buy the first strong up bar after
//   a hard drop) beside a momentum-burst leg. The bounce leg still lost
//   money on its own and dragged the pair under water; the burst leg alone
//   made money, and kept making it across a whole neighbourhood of exit
//   settings, which is what a real signal (as opposed to a lucky fit) looks
//   like on one window.
// - This build is the burst leg alone, with the exits that neighbourhood
//   supported: no fixed take-profit (a continuation trade should not be
//   capped), a trailing stop that locks in the move once it has run, a hard
//   stop underneath, and a maximum hold.
//
// The entry: when the return over the last BURST_WIN bars reaches
// BURST_RISE and the close is the highest close of those bars, buy. That is
// a tape that was quiet, moved hard for half an hour, and is still making
// highs: on a one-minute BTC tape such bursts tend to continue for a while
// rather than snap straight back, and the trailing stop is what turns that
// tendency into kept profit while cutting the bursts that fail.
//
// Exits: a stop at STOP_LOSS under the entry cost; once the position has
// been up at least TRAIL_ARM, a trailing stop TRAIL under the best value
// seen since entry; and a maximum hold of MAX_HOLD bars. A long cooldown
// follows every exit, and no position is opened near the end of the window,
// where the end-of-window flatten would charge an exit for almost no
// exposure. Size is half of equity: large enough for the PnL to matter,
// small enough that the position's own price impact (about 8 bps a side at
// the dev window's pool depth) stays well under the moves being ridden.
//
// Determinism: the bot is a pure function of the hello it received and the
// bars since; it reads no clock, no environment and no file, and uses no
// randomness at all, so the two graded executions agree byte for byte.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- parameters (tuned on the kit's dev window with grade-local) ---
const BURST_WIN = 30; // bars over which a burst is measured
const BURST_RISE = 0.010; // burst strength that buys the continuation (0.007 on the 20261115 window; raised on this kit's dev window, see README)
const SIZE_FRAC = 0.9; // share of equity one position may spend
const STOP_LOSS = -0.005; // exit when the position is down this share of cost
const TRAIL_ARM = 0.003; // profit at which the trailing stop arms
const TRAIL = 0.003; // trailing stop distance under the best value seen
const MAX_HOLD = 300; // bars after which a position is closed regardless
const COOLDOWN = 120; // bars to wait after an exit before entering again
const LAST_ENTRY_SEQ = 1380; // no new entries this close to the window's end
const MAX_SLIPPAGE_BPS = 300; // generous: impact + slippage sit far under this
const MIN_NOTIONAL = 1_000_000n; // a buy must spend at least 1 USDC

// --- mutable run state (reset on hello) ---
let closes: number[] = [];
let entrySeq: number | null = null; // batch seq at which the open position was decided
let peakPnl = 0; // best value/cost - 1 seen since entry
let cooldownUntil = -1; // first seq at which a new entry is allowed again

function reset(): void {
  closes = [];
  entrySeq = null;
  peakPnl = 0;
  cooldownUntil = -1;
}

/** Return of the latest close over the closes of `win` bars ago. */
function retOver(win: number): number | null {
  if (closes.length < win + 1) return null;
  return closes[closes.length - 1] / closes[closes.length - 1 - win] - 1;
}

function buy(state: BarsState): OrderInput[] {
  let notional = BigInt(Math.floor(Number(state.equity) * SIZE_FRAC));
  const room = state.weightRoom(SYMBOL);
  if (notional > room) notional = room;
  if (notional < MIN_NOTIONAL) return [];
  entrySeq = state.seq;
  peakPnl = 0;
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

function sellAll(state: BarsState, qty: bigint): OrderInput[] {
  entrySeq = null;
  peakPnl = 0;
  cooldownUntil = state.seq + COOLDOWN;
  return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onHello() {
    reset();
  },

  onBatch(state: BarsState): OrderInput[] {
    const closeBig = state.close(SYMBOL);
    if (closeBig === null) return [];
    const close = Number(closeBig);
    closes.push(close);

    if (state.warmingUp) return [];

    const holding = state.positions.get(SYMBOL);

    // Manage the open position first: stop, trailing stop, time.
    if (holding !== undefined && holding.qty > 0n) {
      const value = state.value(SYMBOL, holding.qty);
      const pnl = holding.cost > 0n ? Number(value) / Number(holding.cost) - 1 : 0;
      if (pnl > peakPnl) peakPnl = pnl;
      const held = entrySeq === null ? 0 : state.seq - entrySeq;
      let exitNow = false;
      if (pnl <= STOP_LOSS || held >= MAX_HOLD) {
        exitNow = true;
      } else if (peakPnl >= TRAIL_ARM && pnl <= peakPnl - TRAIL) {
        exitNow = true;
      }
      return exitNow ? sellAll(state, holding.qty) : [];
    }

    // Flat: enter only outside cooldown and before the window's tail, on a
    // burst that closes at its window high.
    if (state.seq < cooldownUntil || state.seq > LAST_ENTRY_SEQ) return [];
    const burst = retOver(BURST_WIN);
    if (burst !== null && burst >= BURST_RISE) {
      const win = closes.slice(-BURST_WIN);
      if (close >= Math.max(...win)) return buy(state);
    }

    return [];
  },
});
