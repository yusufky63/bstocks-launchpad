# Base Signal Launcher — Veri Katmanı Denetim Raporu

- Tarih: 2026-09-05
- Kapsam: kayıt (persist), veritabanı, backend okuma katmanı, UI gösterimi, create akışı, trade akışı, indexer, hesap/profil, auth
- Yöntem: statik kod incelemesi + canlı Supabase Postgres sorgusu + Base Mainnet zincir üstü doğrulama (blok 50.923.305)
- Amaç: veri katmanını sıfırdan yeniden yazmadan önce mevcut durumu ve kök nedenleri kayıt altına almak

---

## 0. Yönetici özeti

1. **Uygulamanın "kanonik" veritabanı tamamen boş.** Supabase üzerindeki 54 uygulama tablosundan `b20_v4_launches`, `b20_v4_trades`, `b20_v4_ohlcv_1m`, `b20_v4_token_balances_v1`, `blocks`, `raw_logs`, `indexer_cursors`, `siwe_user_sessions`, `owned_launch_drafts`, `metadata_pin_jobs`, `b20_v4_launch_submissions_v1`, `b20_v4_trade_submissions_v1` dahil 50 tanesi 0 satır. Dolu olan tek anlamlı tablo, migration listesinde bile olmayan `base_signal_private.atomic_launch_attempts_v1` (54 satır).
2. **Indexer hiç çalışmamış ve mevcut yapılandırmayla çalışamaz.** Cursor yok, blok yok. WSS RPC env değişkenleri tanımsız, repo içindeki manifestte coordinator adresi `TBD_DEPLOY`, indexer env'deki "onaylı" manifesti okumuyor.
3. **UI'da görünen her şey 6 farklı rakip kaynaktan geliyor ve seçim 600 ms'lik bir yarış zamanlayıcısına bağlı.** Postgres projeksiyonu → `atomic_launch_attempts_v1` fallback → `apps/web/.data/*.json` dosya deposu → localStorage → statik fixture → GeckoTerminal. Aynı sayfa iki yenilemede farklı veri gösterebiliyor; production modunda ise hiçbir şey göstermez.
4. **Gösterilen veriler büyük oranda uydurma.** Sabit fiyat `0.000034`, blok numarası `1`, launchId `0x00…`, `stateEvidenceFreshness: 'fresh'`, `finality: 'confirmed'` etiketleri sahte veriye de yapıştırılıyor. Holder listesi 950M/50M sabit paylaşımdan üretiliyor; grafik veri yoksa sinüs dalgasıyla mum üretiyor.
5. **Zincir üstü doğrulama kod varsayımlarını çürütüyor.** 7 launch'tan 6'sı doğrudan B20 factory precompile'a gitti ve **hiç Uniswap v4 havuzu oluşturmadı**; 3'ünde DB'deki token adresi zincirdeki gerçek adresle uyuşmuyor (kodu olmayan adresler "confirmed launch" olarak listeleniyor). Tek gerçek havuz (zzzzzzzzz) `fee 0 / tickSpacing 200 / hooks 0x985C14BA…` anahtarıyla açılmış; kodun her katmanı ise `2500 / 25 / hooks yok` varsayıyor. JSON deposundaki "confirmed buy" işlemlerinden biri zincirde **revert** olmuş, biri tamamen uydurma hash.
6. **Auth fiilen kapalı.** Oturum çerezi yoksa herhangi bir istek `x-wallet-address` header'ı veya `?wallet=` parametresiyle istediği cüzdanı "oturum" olarak alıyor; hiçbiri yoksa geliştirici cüzdanı `0xEAa823…` varsayılıyor. Trade kaydı, hesap okuma ve launch review bu yolla yapılabiliyor.
7. **Çalışma alanı riskli.** Git'te tek commit yok, `node_modules` kurulu değil (typecheck/test çalıştırılamadı), kök `.env` içinde `PRIVATE_KEY`, `scratch/` altındaki 10 betikte Supabase şifresi ve Pinata JWT düz metin ve bu klasör `.gitignore`'da değil.

**Sonuç:** "Hepsini silip baştan yaz" kararı doğru. Aşağıda neyin neden bozuk olduğu, hangi dosyaların atılacağı ve yeniden yazımın hangi ilkelerle yapılması gerektiği var.

---

## 1. Doğrulanmış gerçek durum

### 1.1 Veritabanı (Supabase, `aws-0-ap-southeast-2.pooler.supabase.com`, session mode 5432)

| Öğe | Durum |
| --- | --- |
| `public.schema_migrations` | `0001_e1_foundation`, `0002_e5_indexer_foundation`, `0003_e5_projection_rebuild_provenance`, `0006_e8_siwe_sessions`, `0007_e9_b20_v4_launch_market_projection`, `e18_v4_pinata_only_consolidated_baseline_v1` |
| `0021_atomic_launch_attempts_v1` | Tablo var, migration kaydı **yok** (elle uygulanmış) |
| Dolu tablolar | `base_signal_private.atomic_launch_attempts_v1` = 54, `b20_v4_state_refresh_circuits` = 1, `trading_runtime_rate_buckets_v1` = 1 |
| Boş kanonik tablolar | `blocks`, `raw_logs`, `indexer_cursors`, `b20_v4_launches`, `b20_v4_pool_key_events`, `b20_v4_pool_checkpoints`, `b20_v4_trades`, `b20_v4_ohlcv_1m`, `b20_v4_pool_state_evidence`, `b20_v4_token_identities_v1`, `b20_v4_token_balances_v1`, `b20_v4_token_transfer_events_v1` |
| Boş akış tabloları | `owned_launch_drafts`, `metadata_pin_jobs`, `metadata_pin_artifacts`, `b20_v4_launch_reviews_v2`, `b20_v4_launch_submissions_v1`, `b20_v4_trade_submissions_v1`, `b20_v4_trade_attributions_v1`, `direct_v4_quotes_v1`, `siwe_user_sessions`, `wallet_session_bindings_v1` |
| `atomic_launch_attempts_v1` içeriği | 7 satır tx hash'li (hepsi `submission_state='submitted'`, hiçbiri `sealed`, `canonical_token_address` hepsinde NULL), 8 satır `reviewed`, 20 satır sadece metadata, geri kalanı yarım |

Baseline'daki `owned_launch_drafts → metadata_pin_jobs → b20_v4_launch_reviews_v2 → b20_v4_launch_submissions_v1` zinciri kodda kullanılmıyor; `owned-launch-draft-store`, `metadata-pin-store`, `b20-v4-launch-store` ve `b20-v4-launch-submission` modüllerinin tamamı tek bir private tabloya (`atomic_launch_attempts_v1`) INSERT/UPDATE atıyor. Baseline'ın 5.500 satırlık şeması ile gerçek yazma yolu birbirinden kopmuş durumda.

### 1.2 Zincir üstü doğrulama (Base Mainnet)

`atomic_launch_attempts_v1` içindeki 7 gönderim:

| Ad | Tx | Hedef kontrat | Sonuç | v4 havuzu (`Initialize`) | DB `predictedToken` | Zincirdeki gerçek token |
| --- | --- | --- | --- | --- | --- | --- |
| zzzzzzzzz | `0xdf6c2ea4…` | `0xa52ad458…` (launchpad factory) | success | **var** — poolId `0x6d1644cf…`, fee **0**, tickSpacing **200**, hooks **`0x985C14BA…`**, tick 199200 | `0xB2000000…4bD8` | aynı ✔ |
| xxxxxx | `0x70ba439d…` | `0xB20f0000…` (B20 precompile) | success | **yok** | `0xb2000000…52AB` | aynı ✔ |
| testtest | `0x64af2250…` | B20 precompile | success | **yok** | `0xb2000000…DD65` | aynı ✔ |
| sdsfdsdfas | `0xf14f4c21…` | B20 precompile | success | **yok** | `0x84565Cae…` (kodu yok) | `0xb2000000…4049b6…` ✘ |
| testv7 | `0x68f7262c…` | B20 precompile | success | **yok** | `0xb2000000…7613` | aynı ✔ |
| TESTV2 | `0x046ebe2d…` | B20 precompile | success | **yok** | `0xc92f0398…` (kodu yok) | `0xb2000000…50168a…` ✘ |
| test | `0x1c15eaf2…` | B20 precompile | success | **yok** | `0xDc5Bd1AE…` (kodu yok) | `0xb2000000…ab63e8…` ✘ |

Havuz durumu:

| PoolId | Kaynak | Durum |
| --- | --- | --- |
| `0x6d1644cf…` | zzzzzzzzz gerçek havuzu (fee 0 / 200 / hook) | sqrtPriceX96 `1675854689470700423652188972798923`, tick 199199, liquidity `47276272197874011251902` — **canlı** |
| `0x9f98c6b3…` | kodun türettiği "hookless 2500/25" poolId | sqrtPrice 0, liquidity 0 — **havuz yok** |
| `0x434d6d9a…` | xxxxxx için türetilen hookless poolId | initialize edilmiş (tick 68809) ama liquidity 0 |

`apps/web/.data/confirmed_trades.json` içindeki 3 "confirmed" trade:

| Hash | Zincir | JSON'daki kayıt |
| --- | --- | --- |
| `0xbf6fde2d…` | **REVERTED** (blok 50542479, Universal Router) | `buy`, 0.00736 ETH → `"216,470.583"` token, poolId `0x9f98…` (var olmayan havuz) |
| `0x41c447a8…` | success, PoolManager `Swap` poolId `0x6d1644…` | `sell`, 0.001 ETH |
| `0x2222…2222` | receipt yok — **uydurma** | `buy`, 29411 token |

Token `0xB2000000…4bD8` için PoolManager bakiyesi ~999.999.999,36 B20 (arzın tamamı havuzda). Kodun ürettiği holder listesi ise "pool 950M / creator 50M".

### 1.3 Çalışma alanı

| Konu | Durum |
| --- | --- |
| Git | `main` dalında **hiç commit yok**; 27 üst düzey yol untracked |
| Bağımlılıklar | Kök ve `apps/web` altında `node_modules` yok; `pnpm 9.15.4` kurulu, `package.json` `pnpm@11.16.0` + `engineStrict` istiyor → `pnpm typecheck`/`pnpm test` bu makinede çalıştırılamadı |
| Gizli bilgiler | Kök `.env`: `PRIVATE_KEY`, `PINATA_JWT/API/SECRET`. `scratch/*.mjs` (10 dosya): Supabase bağlantı dizesi şifreyle düz metin; `scratch/test-pinata-submit.mjs`: Pinata JWT |
| `.gitignore` boşlukları | `scratch/`, `apps/web/.data/`, `.codex-tmp/`, `.artifacts/`, `.agents/` ignore edilmiyor → ilk commit'te şifreler ve JSON "veritabanı" repoya girer |
| Env dosyaları | `apps/web/.env.local` ve `apps/web/.env.development.local` ikisi de var, neredeyse aynı içerik; `.env.example` `MARKET_READ_REVISION=0007_e9…` derken kod `e18_v4_pinata_only…` literal'ini zorunlu kılıyor |

---

## 2. Veri akışı mimarisi: altı rakip kaynak

```text
                 ┌──────────────────────────────────────────────────────────────┐
  UI (Next.js)   │ /v1/markets  /v1/market-tape  /v1/search  /v1/tokens/:a/*    │
                 │ /v1/trades   /v1/account      /v1/profiles/:a                │
                 └───────────────┬──────────────────────────────────────────────┘
                                 │ readMarketProjectionSource()  (600 ms yarış)
          ┌──────────────────────┼──────────────────────────┬────────────────────┐
          ▼                      ▼                          ▼                    ▼
 (1) Postgres kanonik     (2) atomic_launch_          (3) apps/web/.data/    (4) tarayıcı
     projeksiyon              attempts_v1 fallback        confirmed_*.json       localStorage
     (BOŞ, indexer yok)       (tahmini token, blok=1)     (seed token zorla      (local-created-b20,
                                                           geri ekleniyor)        watchlist)
          │
          └── health başarısız / stale / 600 ms aşıldı → (2) → dev modda (3)

 (5) statik fixture: explore-data.ts, token-market-data.ts, market-fixtures.ts (Beacon / Northstar)
 (6) dış API: GeckoTerminal fetch + iframe (CSP tarafından engelleniyor → sessizce boş)
```

Seçim mantığı (`apps/web/lib/market-projection-read.server.ts:1571-1616`):

- Postgres okuması `Promise.race` ile **600 ms** sınırlanıyor. Sydney'deki Supabase'e Türkiye'den bir transaction (BEGIN + 2×SET + HEALTH + veri + attempts) neredeyse her zaman 600 ms'yi aşar → sonuç `stale`.
- `stale` ise ve `NODE_ENV=development` ise JSON dosya deposuna düşülüyor (`buildConfirmedSnapshot`). `NODE_ENV=production` ise `unavailable` → **hiçbir şey görünmez**.
- Yarış kaybedilse bile arka plandaki DB transaction iptal edilmiyor; havuz `max: 2` olduğu için sonraki istekler kuyruğa girer ve zincirleme timeout üretir.
- Health geçilirse (cursor+blok var ve 60 s'den taze) gerçek projeksiyon okunur; cursor hiç olmadığı için bu dal **şimdiye kadar hiç çalışmadı**.
- Health geçilemezse `atomic_launch_attempts_v1` okunup `status: 'available'` olarak sunuluyor (`:1160-1265`). Bu "kullanılabilir" görünen yanıt tamamen tahmini veridir: `launchBlockNumber: 1`, `launchId: 0x00…`, `closeEth: '0.000001'`, `projectionProgress.caughtUp: true`, `activation: 'live'`.

Bu üç dal üç farklı token kümesi döndürür: (1) hiçbir şey, (2) 7 tahmini token, (3) sadece `zzzzzzzzz`. Kullanıcının gördüğü "sürekli değişiyor / bazen hiç yok" davranışının doğrudan nedeni budur.

---

## 3. Bulgular

Etiketler: **[KRİTİK]** veri doğruluğunu veya güvenliği bozar · **[YÜKSEK]** özellik çalışmıyor · **[ORTA]** yanlış/eksik gösterim · **[DÜŞÜK]** kalite.

### 3.1 Create (launch) akışı

- **[KRİTİK] Create akışı kendi kabul edilmiş spesifikasyonunu ihlal ediyor.** `docs/BASE_B20_UNISWAP_V4_INSTANT_LAUNCH_UPGRADE.md` "doğrudan creator cüzdanına 1 milyar token mint eden ayrı create yolu … sahte market verisi açılamaz" der. Gerçekte 7 launch'ın 6'sı `0xB20f…` precompile'a `createB20` gönderdi, havuz oluşturmadı (§1.2).
- **[KRİTİK] Hedef kontrat env'e göre değişiyor ve reviewed coordinator değil.** `packages/domain/src/base-b20-v4-launch-prepare-v2.ts:621-690`: manifestteki coordinator `0xB20f…` (precompile) veya `0xa52ad458…` ise transaction `createLaunch(...)` ile repo dışı, manifest dışı, kaynağı belgelenmemiş `B20_LAUNCHPAD_FACTORY_ADDRESS = 0xa52ad458…` kontratına gidiyor (`expectedConfigVersion: 10`, hook `0x985C14BA…`). Bu kontratın ABI'si, sahibi ve fee politikası repoda yok.
- **[KRİTİK] "Onaylı" manifest sahte.** `apps/web/.env.local` içindeki `BASE_SIGNAL_APPROVED_MANIFEST_JSON`, `scratch/update-manifest-b20.mjs` ile coordinator adresi precompile'a çevrilmiş, `deploymentBlock: 1`, `deploymentRevision: 7`, `openingPrice.approved: true` (tick 161175) yazılmış bir dosya. `apps/web/lib/b20-v4-launch-production.server.ts:87-89` `NEXT_PUBLIC_APP_ENV=local` iken SHA-256 ve tüm evidence kontrollerini atlıyor.
- **[KRİTİK] Simülasyon uydurma.** `apps/web/lib/b20-v4-launch-prepare.server.ts:1160-1186`: RPC başarısızsa blok `50066531` / hash `0xc9bd4a8e…` sabitleri kullanılıyor; DB'de 4 kayıtta `blockHash: 0x5555…5555`. `:1264-1283` ve `:1285-1355`: predicted token/poolId keccak ile yerelde üretiliyor; sonuç `providerCount: 2`, `status: 'success'` olarak mühürleniyor. Üç launch'ta bu tahmin zincirdeki gerçek adresle uyuşmadı.
- **[YÜKSEK] Runtime doğrulamaları local'de kapalı.** `:850-856` coordinator/gate kod hash doğrulaması, `:889-895` runtime binding, `:1078-1084` gate binding — hepsi `isLocalDev` ise atlanıyor. "Reviewed atomic launch" garantilerinin hiçbiri fiilen çalışmıyor.
- **[YÜKSEK] Submission hiç "sealed" olmuyor.** `b20-v4-launch-submission.server.ts:236-260` sadece `submission_state='submitted'` yazıyor; `reconcile_b20_v4_launch_submission_v1` indexer'dan tetiklenmesi gerekirken indexer çalışmadığı için `canonical_*` kolonları hep NULL. UI ise (`create-intent-workbench.tsx:606-613`) `submitted` durumunda bile "Launch confirmed! Opening live token page" deyip yönlendiriyor.
- **[YÜKSEK] Client tarafı çift kayıt.** `create-intent-workbench.tsx:697-712` tx gönderilir gönderilmez `/v1/tokens/register`'a tahmini adresi POST ediyor; `registerB20V4LaunchSubmission` hata verirse `:714-733` sahte `submitted` cevabı üretip devam ediyor. Bir launch böylece hem JSON dosyasına hem DB'ye, ikisi de doğrulanmadan giriyor.
- **[ORTA] `imageUri: artwork?.name`** (`:706`) — IPFS CID yerine dosya adı ("logo.png") kaydediliyor.
- **[DÜŞÜK] Ölü legacy yol.** `b20-direct-create-client.ts` (1107 satır), `local-created-b20.ts`, `local-direct-b20-attempt.ts` — precompile'a doğrudan create + localStorage; sadece `liquidity-draft-workbench` ve `watchlist-workspace` içinden dolaylı referans. Spesifikasyonun yasakladığı yol hâlâ derleniyor.

### 3.2 Kayıt (persist) katmanı

- **[KRİTİK] JSON dosya deposu.** `apps/web/lib/confirmed-tokens-store.server.ts`: `process.cwd()/.data/confirmed_launches.json` ve `confirmed_trades.json`. `SEED_TOKENS` (`:46-60`) her okumada dosyaya zorla geri ekleniyor (`:76-86`) → `zzzzzzzzz` silinemez. Çok işlem/replica güvenli değil, cwd'ye bağlı, `.gitignore` dışında.
- **[KRİTİK] `/v1/tokens/register` doğrulamasız.** `apps/web/app/v1/tokens/register/route.ts`: auth yok, zod yok, zincir doğrulaması yok; `transactionHash`/`poolId`/`creatorAddress` boşsa sıfırlarla dolduruluyor. Herkes istediği "confirmed token"ı ekleyebilir.
- **[KRİTİK] `/v1/trade-submissions` önce kaydediyor sonra doğruluyor.** `route.ts:44-59`: `saveConfirmedTrade` doğrulamadan önce çağrılıyor; `ethAmount ?? '0.001'`, `tokenAmount ?? '29411'`, `priceEth ?? '0.000034'`, `poolId ?? '0x6d1644…'`, `blockNumber: '1'`. `:61-82`: Postgres kaydı hata verirse sahte `status: 'submitted'` cevabı dönüyor. Revert olan tx'ler bu yüzden "confirmed buy" olarak görünüyor.
- **[YÜKSEK] Sayı formatı bozuk.** `trade-panel.tsx:478-490` `estimatedReceiveFormatted` ("216,470.583" — binlik ayraçlı) değerini `tokenAmount` olarak gönderiyor; `Number("216,470.583")` → `NaN` → hacim/holder hesaplarında 0.
- **[YÜKSEK] Migration disiplini bozuk.** `scripts/database-migration-profiles.ts` lineage'ı 0021'i içermiyor; `setup-local-database.ts` sadece loopback kabul ediyor (Supabase'e uygulanamaz); baseline elle `scratch/apply-baseline.mjs` ile basılmış; `assert_v4_pinata_only_database_catalog_v1` `base_signal_private` şemasını bilmiyor.
- **[ORTA] Aynı token için iki farklı poolId** JSON'da (`0x6d1644…` ve `0x9f98…`); `toProjectedMarket` (`:269+`) `activeLiquidity: '1000000000000000000'`, `stateEvidence.providerCount: 2`, `stateEvidenceFreshness: 'fresh'`, `manifestRevision`, `launchFeeWei: '0'` sabitlerini üretiyor.
- **[DÜŞÜK] Döngüsel import**: `confirmed-tokens-store.server.ts` ↔ `market-projection-read.server.ts`.

### 3.3 Okuma katmanı — Markets, Market Tape, Search, Home

- **[KRİTİK] 600 ms yarış ve üçlü fallback** (§2). `market-projection-read.server.ts:1578-1584`.
- **[KRİTİK] Fallback yanıtları "canlı/taze/confirmed" etiketiyle çıkıyor.** `canonical-surface-read.server.ts:57-64` ve `market-read-response.server.ts:186-206` (`liveMeta`) kaynağa bakmadan `source: 'postgres-confirmed-v4-projection'`, `freshness: 'fresh'`, `finality: 'confirmed'`, `stale: false` yazıyor. `markets-read-model.server.ts` superRefine'ı bunu doğrulayamaz çünkü fallback `asOfTimestamp = now()` üretiyor.
- **[YÜKSEK] Attempts fallback'i sayfalamayı bozuyor.** `:1370-1470` gerçek projeksiyona ek olarak attempts satırlarını `canonicalPosition.blockNumber: '1'`, `eventKey: 'launch-0x…'` (73 karakter altı) ile ekliyor; bu pozisyon `projectionCanonicalPositionSchema`'dan geçmediği için `cursor` ile ikinci sayfa 400 döner. `metadataUri` sabit `'ipfs://bafybeigdyrzt5…'` (`:1436`). Şema `base_signal_private` sabit, `MARKET_READ_SCHEMA` yok sayılıyor. `poolId` ikinci hesaplamada `Buffer.from(string)` ile yanlış (`:1445`).
- **[YÜKSEK] Market Tape sabit fiyat.** `canonical-surface-read.server.ts:155` `closeEth` yoksa `'0.000034'`; `:161` `change24hPercent` null ise `0` bps → "+0%". `market-tape.tsx:48` client'ta aynı sabit tekrar. Header'daki şerit hiçbir zaman "veri yok" demiyor.
- **[ORTA] Home** (`app/page.tsx`) `featured` için `positiveValue` sınıfı sabit; `holders` her zaman `null` (`publicProjectedMarket` `holders: null`).
- **[ORTA] Markets UI** (`explore-registers.tsx`): `TOKEN_GLYPHS` fixture sembollerine (ATLS, BCN, NSTR…) göre ikon; `BCN` için `/beacon-token.png`; 4 s'de bir `/v1/market-board` polling — her poll aynı 600 ms yarışı yeniden oynuyor.
- **[ORTA] Search** (`canonicalSearchResponse`): creator sonuçlarında `basename: null` sabit; doküman sonucu hiç yok (`docs: 0`).
- **[DÜŞÜK] `.env.example` ile kod uyumsuz**: `MARKET_READ_REVISION` literal `e18_v4_pinata_only_consolidated_baseline_v1` olmak zorunda (`:36`), örnek dosya `0007_e9…` diyor → örnekle kurulan ortam sessizce JSON fallback'e düşer.

### 3.4 Token Detail — holders, trades, chart, contract facts, liquidity

- **[KRİTİK] Trades sekmesi hiçbir zaman dolmaz.** API `side: 'buy' | 'sell'` (küçük harf, `market-read-response.server.ts:258`) döner; client parser `use-live-token-market-evidence.ts:94-98` yalnızca `'BUY' | 'SELL'` kabul eder → her satır `null` → "No confirmed trades".
- **[KRİTİK] Holders uydurma.** `canonical-holder-read.server.ts:200-268` `buildConfirmedHolders`: PoolManager 950M, creator 50M sabit; JSON trade'lerden `Number(tokenAmount)` ile bakiye türetme; yanıt `source: 'confirmed-b20-balance-projection'`, `freshness: 'fresh'`, `finality: 'confirmed'`, `coverage: 'canonical-complete'`. Gerçek Postgres yolu (`:132-139`) `target_block = tip` tam eşitliği istiyor → indexer 1 blok geride olsa bile `unavailable` → yine uydurma listeye düşüyor. README "creator'a arz dağıtılmaz" der; zincirde arzın tamamı havuzda.
- **[KRİTİK] Chart sahte mum üretiyor.** `market-chart.tsx:70-96` `generateRichCandles` (sinüs dalgası, `basePrice 0.000034`); `:99-166` 24'ten az mum varsa geçmişe sahte mum ekliyor; `volume || 0.1`. `:283-306` GeckoTerminal fetch — `next.config.ts` CSP `connect-src`'de `api.geckoterminal.com` yok → sessiz hata; iframe engine `frame-src` tarafından engelli → boş kutu. `:186-191` MCap ETH=$2700 sabit. `:266` poolId varsayılanı `0x6d1644…`.
- **[YÜKSEK] Durum metinleri sabit.** `canonical-token-detail.tsx:295-301` `hasFreshStateView = true`, `tradeEnabled = true`; `:351-356` "Live on Base / Uniswap v4 Pool Active" her token için; `:540-545` "PoolId is verified on Uniswap v4" her zaman; `:570` initialTick yoksa `161175`; `:423` poolId yoksa `0x6d1644…`.
- **[YÜKSEK] Contract facts sabit değerlerle dolduruluyor.** `app/v1/tokens/[address]/contract-facts/route.ts:101-114`: Launch ID `0x00…`, blok `'1'`, Metadata URI `'ipfs://bafkreia... (onchain)'`, PoolId `0x6d1644…`, `tickSpacing ?? 200`, Hooks `0x985C14BA…`. Aynı route `tokenReadResponse`'u ikinci kez çalıştırıp JSON'u yeniden parse ediyor; `tokenPayloadSchema` tanımlı ama kullanılmıyor.
- **[ORTA] Holder satırında adres kayboluyor**: `LiveHolders` `holder.label ?? holder.addressDisplay` → "Uniswap v4 Pool" yazısı adresin yerine geçiyor.
- **[ORTA] Token detail sayfası rastgele 404 veriyor**: `getTokenDetailReadModel` aynı 600 ms yarışına bağlı; JSON fallback'te olmayan token (`xxxxxx` vb.) `notFound()`.
- **[DÜŞÜK] Ölü kod**: `defaultInitialCandles`, `LiveCandleChart` (`canonical-token-detail.tsx:126-205`) kullanılmıyor; `token-detail.tsx`, `token-market-records.tsx`, `token-market-data.ts`, `market-fixtures.ts`, `explore-data.ts`, `canonical-token-record.ts` Beacon/Northstar fixture'ları (`canonical-token-record.ts:48` fixture yoksa modül yüklenirken throw).

### 3.5 Trade

- **[KRİTİK] Quote yanlış havuza bakıyor ve uydurma fiyat üretiyor.** `trading-runtime-store.server.ts:415-470` dev modunda JSON deposundan receipt üretip poolId'yi `deriveDirectV4PoolId(token, 2500, 25, 0x0)` ile türetiyor (`0x9f98…` → havuz yok), blok `'1'`, sabit blok hash `0x07eee5…`, coordinator `0xa52ad458…`. `trading-direct-v4.server.ts:999-1015` `getSlot0` başarısız/0 ise `sqrtPriceX96 = 2^96` (1:1 fiyat), tick 161175; `:1097-1104` Quoter başarısızsa `amountOut = amountIn × 29.411.764`; `:1121-1127` price impact aşılırsa 100 bps'e sabitleniyor. Kullanıcı bu sahte quote ile **gerçek** Universal Router transaction'ı imzalıyor → `0xbf6fde…` revert.
- **[KRİTİK] Trade paneli `tradeEnabled=true` ile her token için açık** (havuzu olmayan 6 token dahil).
- **[YÜKSEK] Çalışma zamanı hatası.** `trade-panel.tsx:432-443` `rawAmountIn`, `slippageBps`, `setActiveQuote` tanımsız → prepare başarısız olduğunda `ReferenceError`.
- **[YÜKSEK] Readiness/idempotency dev modda kapalı.** `trading-runtime-store.server.ts:348-360` readiness `isDev || …`; `:756` `findDirectQuote`, `:852` `putDirectQuote` DB'yi atlayıp bellek içi Map kullanıyor → çoklu instance'da quote replay korumasız.
- **[YÜKSEK] Public RPC kullanımı.** `trading-direct-v4.server.ts:336-337` dev'de `https://mainnet.base.org` + `https://1rpc.io/base`; `.env.example` "Public Base RPC fallback is rejected" diyor. `trade-panel.tsx:170-200` client'tan doğrudan public RPC'ye `eth_call` (`NEXT_PUBLIC_ALCHEMY_API_KEY` tarayıcıya sızdırma riski).
- **[ORTA] Sell için SIWE zorunlu, buy için değil; trade kaydı ise auth'suz** (`trade-submissions/route.ts:32-42` sahte oturum).

### 3.6 Hesap (/me) ve profil

- **[KRİTİK] Herkes herkesin hesabını okuyabiliyor.** `app/v1/account/route.ts:30-38`: oturum yoksa `?wallet=` ile herhangi bir cüzdanın "hesabı" dönüyor; o da yoksa sıfır adres.
- **[KRİTİK] Held bakiyesi uydurma.** `canonical-account-read.server.ts:301-315`: creator'a 50M sabit + JSON trade'lerden toplama; `asOfBlock: '1'`, `finality: 'confirmed'`.
- **[YÜKSEK] `queryCreatedTokensFromAttempts` (`:180-230`) her çağrıda yeni Postgres bağlantısı açıp kapatıyor (`prepare` kapatılmamış, pooler ile uyumsuzluk riski); `launchId` hep `0x00…`.
- **[ORTA] `accountReadResponse`** ledger repository yoksa doğrudan uydurma projeksiyona düşüyor (`:466-467`).

### 3.7 Indexer

- **[KRİTİK] Çalışamıyor.** `apps/indexer/src/index.ts:12` watch plan'ı `baseMainnetV4ProductionCandidate` (repo JSON) ile kuruyor; `packages/chain-config/manifests/base-mainnet-v4-production.json` coordinator `TBD_DEPLOY` → `v4-watch-plan.ts:118-121` `degraded`. `config.ts` WSS primary+fallback zorunlu; env'de yok. `INDEXER_START_BLOCK_8453` yok.
- **[KRİTİK] Çalışsa bile mevcut launch'ları reddeder.** `b20-v4-launch-projection.ts:210-220` PoolKey `2500/25/hookless` değilse throw; `uniswap-v4-market-projection.ts:158-160` fee ≠ 2500 ise throw. Gerçek havuz `0/200/hook`. Beklenen `PoolKeyCommitted` + `B20InstantLaunchedV2` olaylarını yayan coordinator zincirde yok; launchpad `0xa52ad458…` farklı olaylar yayıyor.
- **[YÜKSEK] Tazelik penceresi 60 s** (`MARKET_READ_MAX_AGE_SECONDS`) + Supabase RTT + WSS'siz 15 s polling → indexer çalışsa bile okuma katmanı sık sık `stale` diyecek.
- **[ORTA] `REQUIRED_MIGRATIONS`** (`postgres-repository.ts:239-245`) 0021'i bilmiyor; `FORBIDDEN_LEGACY_*` kontrolü web'deki listeyle ayrı ayrı bakımda.

### 3.8 Auth ve güvenlik

- **[KRİTİK] Oturum bypass.** `apps/web/lib/auth-session.server.ts:315-334`: çerez yoksa `x-base-creator`/`x-wallet-address`/`x-creator-address`/`x-swapper-address` header'ı veya `wallet`/`swapper`/`creator` query param'ı cüzdan kabul ediliyor; hiçbiri yoksa `0xEAa823…`; `sessionBindingHash = 0x111…`. `NODE_ENV` koşulu yok — production'da da geçerli. SIWE tabloları bu yüzden boş.
- **[KRİTİK] Gizli bilgiler repo dizininde.** Kök `.env` (`PRIVATE_KEY`, Pinata), `scratch/*.mjs` (DB şifresi ×10, Pinata JWT), hiçbiri ignore değil.
- **[YÜKSEK] Trade kaydı `swapperAddress`'i client'tan alıyor** ve oturum yoksa ona güveniyor (`trade-submissions/route.ts:36`).
- **[ORTA] CSP** `api.geckoterminal.com`'u engellerken kod ona istek atıyor; `unsafe-inline` script.

### 3.9 Kod kalitesi, tip ve test

- `pnpm typecheck` / `pnpm test` çalıştırılamadı (`node_modules` yok, pnpm sürüm uyumsuz). Statik olarak: `trade-panel.tsx` tanımsız değişkenler; `ProjectedMarket` tipine uymayan fazladan alanlar (`launchFeeWei`, `manifestRevision`, `totalVolumeEth`, `tradeCount`, `transactionHash`) fallback nesnelerinde; `contract-facts/route.ts` `any`; `canonical-holder-read.server.ts:197` ve `canonical-account-read.server.ts:178,245` dosya ortasında `import`.
- 73 test dosyası var; çoğu artık bypass edilen yolları (SIWE, owned draft store, metadata pin store) test ediyor → yeşil test, çalışan ürün anlamına gelmiyor.
- `docs/PROJECT_GAP_REPORT_2026-08-12.md` "NO-GO / all writes disabled" derken `.env.local` `METADATA_PIN_WRITES_ENABLED=true`, `DISABLE_UPLOADS=false` ve manifest `create: true` ile mainnet'te 7 gerçek transaction gönderilmiş.

---

## 4. Kök nedenler

1. **Kanonik veri yolu hiç canlandırılmadı, boşluk fallback'lerle kapatıldı.** Indexer çalıştırılamayınca her okuma noktasına (markets, holders, account, quote receipt) ayrı ayrı uydurma/tahmini kaynak eklendi. Her ekleme "confirmed/fresh" etiketlerini de kopyaladı; UI artık gerçek ile sahteyi ayırt edemiyor.
2. **Zincir gerçeği ile kod varsayımı ayrıştı.** Kod her yerde "coordinator + hookless 2500/25" kabul ediyor; deploy edilen şey precompile create (havuzsuz) ve `0xa52ad458…` launchpad (0/200/hook). Bu ayrışma manifest sahteleştirilerek ve dev-mode bypass'larıyla gizlendi.
3. **Dev-mode kısayolları (`NODE_ENV`/`NEXT_PUBLIC_APP_ENV`) güvenlik ve doğruluk kapılarının içine yerleştirildi.** 30'dan fazla `NODE_ENV === 'development'` dalı; auth bypass koşulsuz. "Fail closed" tasarımı fiilen "fail open"a dönüştü.
4. **Üç ayrı yazma hedefi.** Baseline şema (kullanılmıyor), `atomic_launch_attempts_v1` (yarım), JSON dosyaları (doğrulamasız), localStorage. Hiçbiri diğerinin doğruluk kaynağı değil.
5. **Operasyon disiplini yok.** Commit yok, migration kaydı yok, sırlar dizinde, elle `UPDATE` atan scratch betikleri (`fix-existing-row.mjs`) ile veri düzeltilmiş.

---

## 5. Yeniden yazım için öneri

### 5.1 İlkeler

- **Tek doğruluk kaynağı: Postgres.** Dosya deposu, localStorage "veritabanı", attempts fallback ve statik fixture yok. Veri yoksa UI **"veri yok"** gösterir; asla sabit fiyat, sabit holder, sentetik mum üretmez.
- **Yazma sadece zincirden doğrulanmış olay ile.** Bir launch/trade satırı yalnızca (a) tx receipt `status=1` ve (b) beklenen olay (`Initialize`/`Swap`/token create) decode edilip doğrulandıktan sonra yazılır. Client'tan gelen `ethAmount`, `priceEth`, `poolId`, `predictedToken` asla persist edilmez; receipt'ten türetilir.
- **Etiket dürüstlüğü.** `source`, `freshness`, `finality` alanları gerçekten geldiği kaynağı söyler; fallback yoksa etiket de yoktur.
- **Dev-mode bypass yok.** Yerel geliştirme için gerçek local Postgres + gerçek RPC; sahte receipt/quote üreten dal kalmaz. Test için dependency injection kullanılır.
- **Auth ya var ya yok.** Çerez yoksa 401. Header/query ile cüzdan kabul edilmez.

### 5.2 Önce karara bağlanması gerekenler

| Karar | Seçenekler | Etkisi |
| --- | --- | --- |
| Launch kontratı | (a) `0xa52ad458…` launchpad (mevcut, kaynağı belirsiz) · (b) repo'daki `B20InstantLaunchCoordinatorV3` deploy · (c) precompile create + ayrı v4 pool init | Indexer'ın hangi olayları dinleyeceğini ve PoolKey'i belirler |
| PoolKey | mevcut gerçek: `fee 0 / tickSpacing 200 / hooks 0x985C…` · spesifikasyon: `2500 / 25 / hooksız` | Quote, poolId türetme, indexer decoder, UI "0.25%" metni |
| Veritabanı konumu | Supabase (uzak, RTT yüksek) · yerel Postgres (dev) + Supabase (prod) | 600 ms gibi zaman aşımlarının tamamen kaldırılması gerekir |
| Mevcut 7 token | hepsini sil · sadece havuzu olan `zzzzzzzzz`'yi zincirden yeniden türet | Boş başlangıç en temizi |
| SIWE | zorunlu tut (spesifikasyon) · şimdilik yalnız cüzdan imzalı trade kaydı | Auth modülünün kapsamı |

### 5.3 Hedef veri modeli (minimum)

```text
blocks(number PK, hash, parent_hash, timestamp)                  -- reorg için
launches(token PK, creator, tx_hash, block_number, log_index,
         pool_id, fee, tick_spacing, hooks, initial_tick,
         name, symbol, metadata_uri, image_cid, created_at)       -- yalnız receipt doğrulamalı
swaps(tx_hash, log_index PK, pool_id, token, side, amount_eth_wei,
      amount_token_raw, price_eth_e18, sqrt_price_x96, liquidity,
      tick, sender, block_number, block_time)                       -- PoolManager Swap decode
candles_1m(pool_id, bucket PK, o,h,l,c, vol_eth_wei, vol_token_raw, trade_count)  -- swaps'tan türetilir
transfers(tx_hash, log_index PK, token, from, to, amount_raw, block_number)
balances(token, holder PK, balance_raw, as_of_block)             -- transfers'tan türetilir
indexer_cursor(stream PK, next_block, last_hash, updated_at)
sessions(...)  -- SIWE
launch_drafts(id PK, creator, content jsonb, metadata_cid, state, tx_hash NULL)  -- create akışı, sealed olunca launches'a taşınır
```

Toplam ~9 tablo. Baseline'daki 54 tablo / ~80 fonksiyon ve `base_signal_private` şeması atılır.

### 5.4 Akış

1. **Create:** draft → metadata pin → tx hazırla → cüzdan → tx hash'i `launch_drafts.tx_hash`'e yaz → sunucu receipt'i bekler (`eth_getTransactionReceipt`, 2 bağımsız RPC) → `status=1` ve olaylar decode edildiyse `launches`'a yaz, token sayfasına yönlendir; aksi halde draft `failed`. "Confirmed" kelimesi ancak burada kullanılır.
2. **Indexer (tek süreç):** `launches` içindeki poolId listesi + PoolManager `Swap` topic filtresi + token `Transfer` → `swaps`/`transfers` → `candles_1m`/`balances` yeniden hesapla → cursor ilerlet. WSS opsiyonel; HTTP polling yeterli. Reorg: `maxReorgDepth` kadar blok hash karşılaştır, geri sar.
3. **Okuma:** her endpoint tek SQL, yarış zamanlayıcısı yok (`statement_timeout` 5 s), fallback yok. `asOf` = cursor bloğu. Freshness eşiği UI'da uyarı üretir, veriyi gizlemez.
4. **Trade:** receipt `launches`'tan, `getSlot0`/`getLiquidity` **gerçek poolId** ile StateView'dan, quote Quoter'dan; başarısızsa 409/503, uydurma yok. Tx gönderildikten sonra kayıt receipt doğrulamasıyla `swaps`'a indexer üzerinden düşer; client'tan miktar alınmaz.
5. **Hesap:** `launches.creator = wallet`, `balances.holder = wallet`, `swaps` (attribution: tx `from` alanı).

### 5.5 Silinecek / korunacak

Silinecek (veri katmanı):
- `apps/web/.data/`, `apps/web/lib/confirmed-tokens-store.server.ts`, `apps/web/app/v1/tokens/register/`
- `apps/web/lib/market-projection-read.server.ts`, `market-read-response.server.ts`, `markets-read-model.server.ts`, `canonical-surface-read.server.ts`, `canonical-holder-read.server.ts`, `canonical-account-read.server.ts`, `canonical-account-ledger.server.ts` (yeniden, sade)
- `apps/web/lib/trading-runtime-store.server.ts` dev fallback'leri, `trading-direct-v4.server.ts` dev dalları
- `apps/web/lib/b20-v4-launch-{prepare,store,submission,production}.server.ts` isLocalDev dalları ve attempts tablosu; `db/migrations/0021_*`
- `apps/web/lib/{local-created-b20,local-direct-b20-attempt,b20-direct-create-client}.ts`, `explore-data.ts`, `token-market-data.ts`, `market-fixtures.ts`, `canonical-token-record.ts`, `components/token-detail.tsx`, `components/token-market-records.tsx`
- `db/baselines/e18_*.sql` ve `db/migrations/0001-0020` (yeni tek migration)
- `scratch/` (önce sırları döndür), `.codex-tmp/`

Korunacak / uyarlanacak:
- `apps/indexer/src/{pipeline,cursor,confirmed-envelope,rpc,canonical-log}.ts` — reorg-aware çekirdek sağlam; decoder'lar gerçek PoolKey'e göre yeniden yazılır.
- `uniswap-v4-market-projection.ts` Swap decode mantığı (fee kontrolü parametreleşir).
- `metadata-*` pin/gateway modülleri (Pinata akışı çalışıyor; sadece store hedefi değişir).
- UI bileşenlerinin görsel kısmı (`explore-registers`, `canonical-token-detail`, `trade-panel`, `market-chart`) — veri bağlama katmanı sıfırlanır, sahte üretimler kaldırılır.
- `market-chart.tsx` Lightweight Charts entegrasyonu (sentetik mum ve GeckoTerminal çıkarılır).

### 5.6 Uygulama sırası

1. Sırları döndür (Supabase şifresi, Pinata JWT, `PRIVATE_KEY`); `.gitignore`'a `scratch/`, `apps/web/.data/`, `.codex-tmp/`, `.artifacts/` ekle; **ilk commit**.
2. `pnpm` sürümünü eşitle, `pnpm install`, `typecheck`/`test`'i çalışır hale getir (baseline).
3. §5.2 kararları.
4. Yeni tek migration + local Postgres (`docker compose`); Supabase'de eski şemayı `DROP SCHEMA public CASCADE` ile sıfırla.
5. Auth: SIWE zorunlu, bypass'ı sil.
6. Create akışı → `launch_drafts` → receipt doğrulama → `launches`.
7. Indexer: gerçek PoolKey ile Swap/Transfer → candles/balances.
8. Okuma endpoint'leri (markets, tape, search, token, trades, holders, candles, account, profile) — fallback'siz.
9. UI bağlama: boş durumlar, freshness uyarısı, sahte metinlerin kaldırılması.
10. Trade: gerçek poolId ile quote; dev dalları yok.
11. E2E: create → indexer → markets/detail/trade zinciri tek senaryo ile doğrulanır.
