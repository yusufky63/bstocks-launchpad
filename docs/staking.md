# Can people stake into a StockPair pool?

Written 2026-09-11, against the deployed contracts in `packages/contracts/src`. This answers one
question: whether a token's holders, or anyone else, can put tokens into its pool and be paid for
it, and what it would take to make that true.

## The short answer

They can add liquidity today, permissionlessly, and they would earn nothing for it.

Everything below is why, and what the three real options cost.

## What the pool actually is

`StockPairFactory.launch` creates one Uniswap v4 pool per token and puts the entire supply into it
as a single-sided position the factory holds and cannot withdraw. Two constants decide everything
about staking:

```solidity
uint24 public constant LP_FEE = 0;          // StockPairFactory.sol:86
uint256 public constant CREATOR_SHARE_BPS = 7_000;  // StockPairHook.sol:53
```

The pool's own swap fee is **zero**. The 1% is charged by the hook, on the stock side of every swap,
and booked to two balances:

```solidity
claimable[info.stock][info.creator] += creatorAmount;   // 70%
claimable[info.stock][treasury]     += platformAmount;  // 30%
```

Withdrawn with `claim(stock)` or `claimMany(stocks)`.

So the fee never reaches liquidity providers. It is routed past them, by design.

## Can an outsider add liquidity at all?

Yes, and nothing can stop them. The hook declares:

```solidity
beforeAddLiquidity:  false,
afterAddLiquidity:   false,
beforeRemoveLiquidity: false,
afterRemoveLiquidity:  false,
```

Only `beforeInitialize` is hooked, and it is restricted to the factory, which gates pool *creation*
rather than pool *use*. Anyone holding the token and its paired stock can mint a position through
Uniswap's own PoolManager or position manager. The app has no UI for it; the chain has no objection.

The `PoolKey` needed to do so is reconstructible from what the indexer already stores: `token`,
`stock`, `token_is_currency0`, and the two constants above. `pool_id` alone is not enough, because
v4 addresses a pool by its key and the id is the hash of it.

**Do not build a UI for this.** An outside LP would take inventory risk and impermanent loss on a
token whose entire supply is already in the pool, in exchange for zero fee income. It is not a
yield opportunity, it is a donation with extra steps.

## Option A: pay LPs from the hook

Change the split so a share of the 1% accrues to liquidity providers instead of only to the creator
and the treasury.

**Cost: a new hook and a new factory, and existing pools keep the old one.** The hook address is
baked into every `PoolKey` and set once in the factory with no upgrade path. Changing the split
means redeploying both, and every token launched before the change stays on the old hook forever.
The launchpad would be running two incompatible generations of pool at once.

Only worth considering if it happens before there is meaningful volume to strand.

## Option B: a creator-funded staking contract

The creator already receives 70% of the fee to an address they control and claims it themselves.
Nothing stops them pointing that address at a staking contract and distributing what arrives.

**Cost: one new contract, and no change to anything deployed.** The hook, the factory and every
existing pool are untouched, because from their side nothing has changed: fees still accrue to the
creator's address. This is the only option that is purely additive.

What it needs:

- A staking contract holding the launched token, with rewards paid in the **paired stock**, which is
  what the fee actually is. Paying rewards in the launched token instead would mean minting, and the
  supply is fixed at 1,000,000,000 with no mint path.
- The creator funds it by claiming and depositing. That is a promise, not a guarantee: a creator can
  stop at any time. Whatever the UI says about this has to say that plainly, or it is telling people
  a yield is safer than it is.
- Standard staking hygiene: rewards accounted per share and settled on every balance change,
  withdrawals never blocked by the reward path, and no rebasing.

## Option C: locking without yield

Stakers lock tokens for a period and get something that is not money: a badge, an allocation, a
governance weight, a place in a queue.

**Cost: one new contract, and no economics to get wrong.** No reward accounting, no funding promise,
no way for it to run dry. It is the honest version of the feature when there is no revenue to share,
and it is the one to build first if the point is engagement rather than yield.

## Recommendation

**B if a creator asks for it, C if the launchpad wants it as a platform feature, never A after
volume exists.**

And whichever is built, one line of copy is not optional: rewards in B come from a creator who
chose to share them and can stop, and the pool itself pays nothing. A staking page that implies
protocol yield where there is none is the kind of thing this codebase has been careful to avoid
everywhere else.

## Security notes for whoever builds B or C

- **Reward token is the stock, not the launched token.** The stock is a B20 with 8 decimals and a
  multiplier; read `WAD_PRECISION()` rather than assuming, and never assume 18.
- **The stock can be paused.** A corporate action freezes the issuer's feed and mint/redeem, and the
  token itself can be paused onchain. A staking contract must let people withdraw their *stake* even
  when the *reward* transfer would revert, or a pause traps deposits.
- **Never trust the creator profile for anything but display.** `name`, `symbol`, `description`,
  `website` are chosen by whoever paid the launch fee. They are not identity.
- **The 20 second anti-snipe window applies to the pool, not to staking**, but a staking UI that
  links to a fresh token still has to show the countdown, for the same reason the token card does.
- **Do not read `pool_id` as an address.** It is a hash. Interactions need the full `PoolKey`.
