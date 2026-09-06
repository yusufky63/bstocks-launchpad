import type { Address } from 'viem';

export type StockDefinition = Readonly<{
  /** B20 token address on Base (checksummed). */
  address: Address;
  /** Token symbol as reported onchain, e.g. NVDAc. */
  symbol: string;
  /** Underlying equity ticker, e.g. NVDA. */
  ticker: string;
  name: string;
  decimals: 8;
  /** Chainlink total-return feed (8 decimals, 24/5). */
  feed: Address;
  /** Official icon from the token's onchain contractURI metadata (metadata.coinbase.com). */
  image: string;
}>;

/**
 * Coinbase tokenized stocks on Base and their Chainlink feeds.
 * Source: docs.base.org "Tokenized Stocks on Base", September 2026.
 * The factory registry onchain is the authority; this list seeds the database and the UI.
 */
const STOCK_ICON_BASE = 'https://metadata.coinbase.com/equity_icons';

export const BASE_STOCKS: readonly StockDefinition[] = Object.freeze([
  { address: '0xb20000000000000000000078ee7ce2fE4908108C', symbol: 'NVDAc', ticker: 'NVDA', name: 'NVIDIA Corporation', decimals: 8, feed: '0x04689a41629776563E6822F76f2e57D148d28513', image: `${STOCK_ICON_BASE}/1fee9b7a44e800d438dd9d96c3283e05784c925c2c871a48ff735950740b551a.png` },
  { address: '0xb200000000000000000000C2e324d24d7eEcd1fb', symbol: 'AAPLc', ticker: 'AAPL', name: 'Apple Inc.', decimals: 8, feed: '0x787f13dEa48Db0897CbCDD985de77809D837F988', image: `${STOCK_ICON_BASE}/873819f4b14efe44b94abecbc8e8864d2998163abd0ca55b449ee6eb07d0d94c.png` },
  { address: '0xb2000000000000000000008bC8786B856E61707C', symbol: 'METAc', ticker: 'META', name: 'Meta Platforms', decimals: 8, feed: '0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D', image: `${STOCK_ICON_BASE}/1cedbfb3caee9498470945ff5041715b8c90921d904b3567a43bc4df82069e66.png` },
  { address: '0xb2000000000000000000002D0BA3164cc74f58B7', symbol: 'GOOGLc', ticker: 'GOOGL', name: 'Alphabet', decimals: 8, feed: '0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2', image: `${STOCK_ICON_BASE}/0e80e31df40f7c42b49a3c7f6d23c6351625d73f235aeb69006ddee9221702b0.png` },
  { address: '0xb2000000000000000000001e800a7f5189430cD0', symbol: 'TSLAc', ticker: 'TSLA', name: 'Tesla Inc.', decimals: 8, feed: '0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4', image: `${STOCK_ICON_BASE}/a3b67028295d0e9fa3182c867b8a9afed5ebcbd8c012de3a46e160ae5e490980.png` },
  { address: '0xB200000000000000000000Ab99cFa739E253872B', symbol: 'MSFTc', ticker: 'MSFT', name: 'Microsoft', decimals: 8, feed: '0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c', image: `${STOCK_ICON_BASE}/e90930ade985016f48816c6bd9fd1e8274b28507f4833881b3a16c77c2a3e2e7.png` },
  { address: '0xb200000000000000000000d9192b6B456483C2E8', symbol: 'AMZNc', ticker: 'AMZN', name: 'Amazon', decimals: 8, feed: '0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295', image: `${STOCK_ICON_BASE}/06d3c2cac2c89e3a8bc4b2fe40ff259f104b55244321dea400e44b22f215896b.png` },
  { address: '0xb2000000000000000000004884b426556b92883d', symbol: 'MSTRc', ticker: 'MSTR', name: 'Strategy (MicroStrategy)', decimals: 8, feed: '0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a', image: `${STOCK_ICON_BASE}/496024423dd795f8b547ffa0668f12a1e6bf09af247534754546a1a6661c7969.png` },
  { address: '0xb200000000000000000000397293Cb8cda9a10c5', symbol: 'SNDKc', ticker: 'SNDK', name: 'Sandisk', decimals: 8, feed: '0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA', image: `${STOCK_ICON_BASE}/495de6bc9902690826d533b9506494890f59d611d10f04231c00936f659bb0cb.png` },
  { address: '0xb2000000000000000000007b9fcbd005511aCBd5', symbol: 'SPCXc', ticker: 'SPCX', name: 'SpaceX', decimals: 8, feed: '0x6A634B235903C4ad6376892180d6fF8612e3Fa68', image: `${STOCK_ICON_BASE}/79fa65beabbe27c7b84a38b8f67a492793a0c203a5312c8feddc23e4b7c66b79.png` },
  { address: '0xb200000000000000000000c85a31389D71F3ecfb', symbol: 'COINc', ticker: 'COIN', name: 'Coinbase Global', decimals: 8, feed: '0x408e44f504A7371a345F03a73dDC96A4b48e8aa7', image: `${STOCK_ICON_BASE}/fe40327c3d69c3c210e6d2b0819e69514f5be58dff6605507583170b7bb14790.png` },
  { address: '0xB20000000000000000000019f6E7C675b73C2e4D', symbol: 'CRCLc', ticker: 'CRCL', name: 'Circle Internet Group', decimals: 8, feed: '0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33', image: `${STOCK_ICON_BASE}/f217835f2637739f460cc9335a59ec96011c1b9510a40cee3243aeef50eb7a45.png` },
  { address: '0xB2000000000000000000004AFF16039bA04bdFBc', symbol: 'INTCc', ticker: 'INTC', name: 'Intel', decimals: 8, feed: '0xAB657C39bac0D5886250D70849e2E3E008F2EECB', image: `${STOCK_ICON_BASE}/cc2d84b704e34b83b5fc1f3b0e89c67e5ccc9142e666a50a5cbde261cf09e2aa.png` },
]);

export function findStock(address: string): StockDefinition | undefined {
  const needle = address.toLowerCase();
  return BASE_STOCKS.find((stock) => stock.address.toLowerCase() === needle);
}

export function findStockBySymbol(symbol: string): StockDefinition | undefined {
  const needle = symbol.toLowerCase();
  return BASE_STOCKS.find(
    (stock) => stock.symbol.toLowerCase() === needle || stock.ticker.toLowerCase() === needle,
  );
}
