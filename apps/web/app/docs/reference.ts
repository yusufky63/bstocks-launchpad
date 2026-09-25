import type { StockPairDeployment } from '@stockpair/core';

/**
 * Data behind the docs page. Every selector and topic is the contracts' own: test/docs.test.ts
 * recomputes each one from the ABIs in @stockpair/core, so a contract change that is not carried
 * over here fails the web tests instead of shipping a wrong reference.
 */

export type RefSource = 'factory' | 'hook' | 'router' | 'external';

export type RefItem = Readonly<{
  source: RefSource;
  /** Contract name as shown on the page. */
  contract: string;
  /** Solidity-style declaration, with struct names instead of tuples. */
  display: string;
  /** Four-byte selector for functions and errors, the full topic for events. */
  id: `0x${string}`;
  note: string;
  /** Canonical signature, only for items that are not in our ABIs (they are hashed directly). */
  signature?: string;
}>;

/** The owner's wording, used everywhere the site or the README says a token has no admin. */
export const ZERO_ADMIN =
  'No token launched here has an admin: nobody can mint, burn, pause, block transfers or touch the locked liquidity. If a creator chose an editable profile, the launch factory, a non-upgradeable contract, holds one metadata-only permission on that token. Its code uses it for exactly one thing: pointing the token at a new IPFS profile when the original creator asks. The creator can give it up for good. Name, symbol and supply can never change.';

const FACTORY = 'StockPairFactory';
const HOOK = 'StockPairHook';
const ROUTER = 'StockPairRouter';

export const FUNCTIONS: readonly RefItem[] = [
  { source: 'factory', contract: FACTORY, display: 'launch(LaunchParams p) payable returns (address token, PoolId poolId)', id: '0x28314fb2', note: 'Fixed profile, no buy, no deadline. Same selector on every factory; the first one checks only text lengths.' },
  { source: 'factory', contract: FACTORY, display: 'launchWithOptions(LaunchParams p, LaunchOptions o) payable returns (address token, PoolId poolId)', id: '0x01499600', note: 'Adds the deadline, the opening-valuation check and the editable-profile choice.' },
  { source: 'factory', contract: FACTORY, display: 'launchAndBuy(LaunchParams p, LaunchOptions o, CreatorBuy b) payable returns (address token, PoolId poolId, uint256 tokensOut)', id: '0xd0150e4f', note: 'launchWithOptions, then a buy for the sender in the same transaction.' },
  { source: 'factory', contract: FACTORY, display: 'updateContractURI(address token, string newURI)', id: '0x6697392e', note: 'Original creator of an editable token only. Only ipfs:// and a bare CID: letters and digits, no path.' },
  { source: 'factory', contract: FACTORY, display: 'lockMetadata(address token)', id: '0x37d1df5f', note: 'Original creator only. Ends editing for good.' },
  { source: 'factory', contract: FACTORY, display: 'metadataStatus(address token) view returns (MetadataStatus)', id: '0x9ce0634d', note: '0 Immutable, 1 Editable, 2 Locked. Read live from the token.' },
  { source: 'factory', contract: FACTORY, display: 'predictToken(address creator, bytes32 salt) view returns (address)', id: '0x486e36c8', note: 'The address a launch with this salt will create.' },
  { source: 'factory', contract: FACTORY, display: 'previewOpening(address stock, address token) view returns (uint160 sqrtPriceX96, int24 tick, uint256 stockUsd8)', id: '0x9affe51a', note: 'The opening price a launch would get right now.' },
  { source: 'factory', contract: FACTORY, display: 'launchOf(address token) view returns (Launch)', id: '0x029282d7', note: 'Stock, creator, range, liquidity, time and opening price of a launch.' },
  { source: 'factory', contract: FACTORY, display: 'poolKeyOf(address token) view returns (PoolKey)', id: '0x8652edf9', note: 'The Uniswap v4 pool key of a launched token.' },
  { source: 'factory', contract: FACTORY, display: 'stockInfo(address stock) view returns (Stock)', id: '0x4949a2e7', note: 'Feed, enabled flag, decimals and symbol of a registered stock.' },
  { source: 'factory', contract: FACTORY, display: 'creationFee() view returns (uint256)', id: '0xdce0b4e4', note: 'The exact msg.value every launch sends.' },
  { source: 'factory', contract: FACTORY, display: 'openingFdvUsd8() view returns (uint256)', id: '0xbf778e65', note: 'Opening valuation in USD, 8 decimals.' },
  { source: 'factory', contract: FACTORY, display: 'setCreationFee(uint256 fee)', id: '0xb7d86225', note: 'Owner. At most 0.01 ETH.' },
  { source: 'factory', contract: FACTORY, display: 'setOpeningFdv(uint256 fdvUsd8)', id: '0xbb771f5d', note: 'Owner. $100 to $1,000,000.' },
  { source: 'factory', contract: FACTORY, display: 'setTreasury(address treasury)', id: '0xf0f44260', note: 'Owner.' },
  { source: 'factory', contract: FACTORY, display: 'addStock(address stock, address feed, string symbol, uint8 decimals)', id: '0xba5e9189', note: 'Owner. The feed must report 8 decimals.' },
  { source: 'factory', contract: FACTORY, display: 'setStockEnabled(address stock, bool enabled)', id: '0x492a5578', note: 'Owner. New launches only; existing pools are unaffected.' },
  { source: 'factory', contract: FACTORY, display: 'setHook(address hook)', id: '0x3dfd3873', note: 'Owner. Once.' },
  { source: 'hook', contract: HOOK, display: 'claim(address stock) returns (uint256 amount)', id: '0x1e83409a', note: "Pays the caller's claimable fees in that stock." },
  { source: 'hook', contract: HOOK, display: 'claimMany(address[] stocks) returns (uint256[] amounts)', id: '0x7e686e01', note: 'The same for several stocks; empty balances are skipped.' },
  { source: 'hook', contract: HOOK, display: 'claimable(address stock, address account) view returns (uint256)', id: '0xd4570c1c', note: 'Fees booked to an account, in stock units.' },
  { source: 'hook', contract: HOOK, display: 'totalFees(PoolId id) view returns (uint256)', id: '0x6b491bd0', note: 'Lifetime fees of a pool, in stock units.' },
  { source: 'hook', contract: HOOK, display: 'currentFeeBps(PoolId id) view returns (uint256)', id: '0x1d8ef3ef', note: 'The fee a swap in this pool pays now, in basis points.' },
  { source: 'hook', contract: HOOK, display: 'poolInfo(PoolId id) view returns (PoolInfo)', id: '0x8cebd942', note: 'Token, stock, creator and launch time of a pool.' },
  { source: 'router', contract: ROUTER, display: 'swapExactIn(PoolKey key, bool zeroForOne, uint128 amountIn, uint128 minAmountOut, address recipient, uint256 deadline) returns (uint256 amountOut)', id: '0x8409da66', note: 'Exact-input swap with a minimum output and a deadline.' },
];

export const EVENTS: readonly RefItem[] = [
  { source: 'factory', contract: FACTORY, display: 'Launched(address indexed token, address indexed creator, address indexed stock, PoolId poolId, uint160 sqrtPriceX96, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 stockUsd8, string name, string symbol, string contractURI)', id: '0x545827070fae462314f8e79f25d99f8e713bf3cecb38728eb4c4804e1e20d0a6', note: 'Every launch. The same on every factory.' },
  { source: 'factory', contract: FACTORY, display: 'MetadataEditable(address indexed token, address indexed creator)', id: '0x1241a65d78d66378b38c08d6c0fc8deaa8e6f592ffc4bfc685d51af653f1bb6f', note: 'The log right after Launched, when the creator chose an editable profile.' },
  { source: 'factory', contract: FACTORY, display: 'CreatorBought(address indexed token, address indexed creator, PoolId indexed poolId, uint256 stockIn, uint256 fee, uint256 tokensOut)', id: '0x43d15e9d32712a10d4ab74467519cf3a13edcf6de23f4894edbb0abf319b9f65', note: 'The buy in launchAndBuy. The last log of the launch.' },
  { source: 'factory', contract: FACTORY, display: 'ContractURIChanged(address indexed token, address indexed creator, string contractURI)', id: '0xb23802208f960154d35feb1ddb4ed3718dd9ea1c6af17d702f83bb34f3c6ab4b', note: 'Every profile update of an editable token.' },
  { source: 'factory', contract: FACTORY, display: 'MetadataLocked(address indexed token, address indexed creator)', id: '0x1653aa4ca9f980f3b8b3aaa209e5f5d445c8688450cd1bc630a19b5211679aa8', note: 'The creator locked the profile.' },
  { source: 'factory', contract: FACTORY, display: 'StockAdded(address indexed stock, address indexed feed, string symbol, uint8 decimals)', id: '0x3572fbfa06ac9234af5d48e012aedc365ca671a1144b7ae431000abebbe72f1a', note: 'Owner registered a stock.' },
  { source: 'factory', contract: FACTORY, display: 'StockEnabled(address indexed stock, bool enabled)', id: '0xac94a866eb4787d79661bd9f67018689dbfe5ed99cfc16f604a022911fdf54bb', note: 'Owner enabled or disabled a stock for new launches.' },
  { source: 'factory', contract: FACTORY, display: 'CreationFeeSet(uint256 fee)', id: '0x65cf44d7c3dc10549f322afbe745b2a569e6e2a177f9465749a393afbc9c354f', note: 'Owner changed the creation fee.' },
  { source: 'factory', contract: FACTORY, display: 'OpeningFdvSet(uint256 fdvUsd8)', id: '0x2a64b70825c76cc32d90943f51cfe02ea329703ca5540f64c3412dea95dcce97', note: 'Owner changed the opening valuation.' },
  { source: 'factory', contract: FACTORY, display: 'TreasurySet(address indexed treasury)', id: '0x3c864541ef71378c6229510ed90f376565ee42d9c5e0904a984a9e863e6db44f', note: 'Owner changed the treasury.' },
  { source: 'factory', contract: FACTORY, display: 'HookSet(address indexed hook)', id: '0x4eab7b127c764308788622363ad3e9532de3dfba7845bd4f84c125a22544255a', note: 'The hook was set, once.' },
  { source: 'hook', contract: HOOK, display: 'PoolRegistered(PoolId indexed poolId, address indexed token, address indexed stock, address creator)', id: '0x01bf263a1db1652580721573296e1a1fa70b3d4c87f61d02a69c4e1109d2d573', note: 'The factory registered a new pool, inside its launch.' },
  { source: 'hook', contract: HOOK, display: 'FeeCharged(PoolId indexed poolId, address indexed stock, uint256 amount, uint256 creatorAmount, uint256 platformAmount, uint256 feeBps)', id: '0x8b0e4cf39120c70654d9e54bb37acd7e4b571480cac924f4d96ebaf14b35093d', note: "Every swap with a non-zero fee. Before its PoolManager Swap log when the stock is the specified amount (exact-input buy, exact-output sell); after it otherwise (exact-input sell, exact-output buy). None when the fee rounds to zero." },
  { source: 'hook', contract: HOOK, display: 'FeesClaimed(address indexed stock, address indexed account, uint256 amount)', id: '0xfe3464cd748424446c37877c28ce5b700222c5bc9f90d908afcc4e5cb22707ff', note: 'A claim was paid out.' },
  { source: 'router', contract: ROUTER, display: 'Swapped(address indexed payer, address indexed recipient, address indexed tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)', id: '0xd6d4f5681c246c9f42c203e287975af1601f8df8035a9251f79aab5c8f09e2f8', note: 'A swap through this router.' },
  { source: 'external', contract: 'B20 token', display: 'ContractURIUpdated()', id: '0xa5d4097edda6d87cb9329af83fb3712ef77eeb13738ffe43cc35a4ce305ad962', note: "The token's own ERC-7572 event, next to every ContractURIChanged.", signature: 'ContractURIUpdated()' },
];

export const ERRORS: readonly RefItem[] = [
  { source: 'factory', contract: FACTORY, display: 'WrongCreationFee()', id: '0x44402b7b', note: 'msg.value is not exactly the creation fee.' },
  { source: 'factory', contract: FACTORY, display: 'StockNotEnabled()', id: '0xa57d5da7', note: 'The stock is not registered or not enabled for new launches.' },
  { source: 'factory', contract: FACTORY, display: 'InvalidText()', id: '0x7a2a029c', note: 'Name, symbol or contract URI too long, empty or with control characters; or an editable profile whose link is not ipfs:// and a bare CID.' },
  { source: 'factory', contract: FACTORY, display: 'StaleFeed()', id: '0xa0cd3bb2', note: 'The Chainlink reading is older than 7 days, or in the future.' },
  { source: 'factory', contract: FACTORY, display: 'InvalidFeed()', id: '0x1f86e170', note: 'The feed answered zero or less, or does not report 8 decimals.' },
  { source: 'factory', contract: `${FACTORY}, ${ROUTER}`, display: 'Expired()', id: '0x203d82d8', note: 'Included after the deadline. The deadline itself still passes.' },
  { source: 'factory', contract: FACTORY, display: 'OpeningFdvChanged()', id: '0x7156ad5e', note: 'The owner changed the opening valuation after the creator reviewed it.' },
  { source: 'factory', contract: `${FACTORY}, ${ROUTER}`, display: 'ZeroAmount()', id: '0x1f2a2005', note: 'stockIn or minTokensOut of zero in launchAndBuy; amountIn of zero in the router.' },
  { source: 'factory', contract: `${FACTORY}, ${ROUTER}`, display: 'TooLittleReceived()', id: '0xc9f52c71', note: 'The output is below the minimum. In launchAndBuy, nothing is launched.' },
  { source: 'factory', contract: FACTORY, display: 'OutOfBounds()', id: '0xb4120f14', note: 'stockIn above the int128 maximum, or an owner setting outside its bounds.' },
  { source: 'factory', contract: FACTORY, display: 'NotCreator()', id: '0x93687c0b', note: 'Only the original creator can update or lock a profile.' },
  { source: 'factory', contract: FACTORY, display: 'MetadataNotEditable()', id: '0x4a38a31a', note: 'The token was launched with a fixed profile, or it is locked.' },
  { source: 'factory', contract: FACTORY, display: 'UnexpectedRoles()', id: '0xa507f32b', note: "The new token's metadata role is not exactly what the launch asked for." },
  { source: 'factory', contract: FACTORY, display: 'UnexpectedSupply()', id: '0xe9531af4', note: 'The new token did not mint exactly 1,000,000,000 to the factory.' },
  { source: 'factory', contract: FACTORY, display: 'UnexpectedDelta()', id: '0x29a70758', note: 'The PoolManager settled a seed or buy differently than expected.' },
  { source: 'factory', contract: FACTORY, display: 'InvalidRange()', id: '0x561ce9bb', note: 'The opening range would hold no liquidity.' },
  { source: 'factory', contract: FACTORY, display: 'TreasuryTransferFailed()', id: '0x0e373cf8', note: 'The treasury refused the creation fee.' },
  { source: 'factory', contract: FACTORY, display: 'HookNotSet()', id: '0x86972930', note: 'Launches are not open yet.' },
  { source: 'factory', contract: FACTORY, display: 'HookAlreadySet()', id: '0xbef9156a', note: 'Owner. The hook can be set only once.' },
  { source: 'factory', contract: FACTORY, display: 'StockAlreadyAdded()', id: '0xe3842940', note: 'Owner. A stock is registered once.' },
  { source: 'factory', contract: FACTORY, display: 'ZeroAddress()', id: '0xd92e233d', note: 'Owner. The treasury cannot be the zero address.' },
  { source: 'factory', contract: `${FACTORY}, ${ROUTER}`, display: 'OnlyPoolManager()', id: '0xf655705d', note: 'An unlock callback called by anything but the PoolManager.' },
  { source: 'hook', contract: HOOK, display: 'PartialFill()', id: '0xd964f528', note: 'A swap that specified a stock amount did not fill all of it. Arrives inside WrappedError.' },
  { source: 'hook', contract: HOOK, display: 'UnknownPool()', id: '0xf7139e33', note: 'A swap in a pool the hook has not registered, including one still being launched.' },
  { source: 'hook', contract: HOOK, display: 'NothingToClaim()', id: '0x969bf728', note: 'claim with a zero balance.' },
  { source: 'hook', contract: HOOK, display: 'OnlyFactory()', id: '0x0c6d42ae', note: 'Only the factory creates and registers pools with this hook.' },
  { source: 'external', contract: 'Uniswap v4 PoolManager', display: 'WrappedError(address target, bytes4 selector, bytes reason, bytes details)', id: '0x90bfb865', note: "How v4 passes on a hook's revert. reason holds PartialFill.", signature: 'WrappedError(address,bytes4,bytes,bytes)' },
];

export type Threshold = Readonly<{ setting: string; range: string; behaviour: string }>;

/** The web app's own limits. Only the rows that say "onchain" are enforced by the contracts. */
export const THRESHOLDS: readonly Threshold[] = [
  { setting: 'Trade slippage', range: '0.1% to 5% · default 1% · presets 0.5, 1, 3, 5%', behaviour: 'Amber from 3%. A value outside the range is rejected, never rounded into it.' },
  { setting: 'Price impact', range: 'amber from 5% · red from 25%', behaviour: 'Red needs a tick before Confirm. Impact alone never blocks a trade.' },
  { setting: 'Buy-at-launch tolerance', range: '0.5% to 5% · default 2% · presets 1, 2, 3, 5%', behaviour: 'Covers the Chainlink price moving before the launch lands. Not remembered between visits.' },
  { setting: 'Buy-at-launch share', range: '5% amber · 15% red · 50% blocked', behaviour: "Share of supply, checked at review and again right before sending. Red needs a tick. The 50% block is this site's; the contract has no cap." },
  { setting: 'Deadline', range: '10 minutes', behaviour: 'Trades, and launches through launchWithOptions or launchAndBuy. Counted from the later of the latest block and your clock, after any approval confirms.' },
  { setting: 'Feed age', range: '7 days onchain · 1 hour on this site', behaviour: 'Older than 7 days, a launch reverts. Older than 1 hour, the create form says the market is closed and uses the last price.' },
];

/** Base mainnet: block 0 at this unix time, then one block every 2 seconds. */
const BASE_GENESIS_TIME = 1_686_789_347;
const BASE_BLOCK_SECONDS = 2;

/** UTC day of a Base mainnet block, as YYYY-MM-DD. */
export function baseBlockDate(block: bigint): string {
  return new Date((BASE_GENESIS_TIME + Number(block) * BASE_BLOCK_SECONDS) * 1000).toISOString().slice(0, 10);
}

/** Deployments labelled by deploy date. A block of 0 means the env did not say, so no date is claimed. */
export function deploymentLabel(d: Pick<StockPairDeployment, 'deployBlock'>): string {
  return d.deployBlock > 0n ? `Deployed ${baseBlockDate(d.deployBlock)}` : 'Deploy block not configured';
}
