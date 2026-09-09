# Yapılacaklar — 9 Eylül 2026 incelemesinin doğrulanmış hâli

Kaynak: `launchpad_factory_base_inceleme_2026-09-09.md` (revizyon `a819d3e`).
Her madde kodun kendisiyle veya zincirden okumayla ayrıca kontrol edildi. Durum sütunu şunu söyler:

- **Doğrulandı** — iddiayı koda bakarak teyit ettim, satır referansı verildi.
- **Zaten düzeltildi** — rapor yazıldıktan sonra çözüldü, commit verildi.
- **Kısmen** — çekirdek doğru ama ifadesi veya etkisi düzeltilmeli.

---

## A. Yayılmadan önce yapılması gerekenler

### A1 — Anti-snipe exact-output ile aşılıyor · **Doğrulandı** · yeni hook gerektirir

`StockPairHook.sol:196-221`. Ücret *specified* taraf üzerinden alınıyor. Exact-input alışta specified
girdidir, yani trader'ın ödediği tutar. Exact-output alışta specified çıktıdır (token), ücret
`afterSwap`'te *unspecified* olan havuz girdisinden alınır.

Aynı havuz hareketi için, %99 penceresinde:

| Yol | Trader öder | Havuza girer | Ücret | Ücret / ödeme |
| --- | ---: | ---: | ---: | ---: |
| Exact-input | 100 | 1 | 99 | %99 |
| Exact-output | 1.99 | 1 | 0.99 | **%49.75** |

Aynı sonucu almak **~50 kat ucuz**. Kendi router'ımız yalnızca exact-in sunuyor ama hook'u herhangi
bir v4 router çağırabilir; koruma router'da değil hook'ta olmalı.

Testler bu pencereyi hiç kapsamıyor: `StockPair.t.sol:328` ve `:354`, ikisi de `vm.warp(+21)` ile
pencereyi atlıyor.

**Yapılacak:** İlk 20 saniyede exact-output'u hook seviyesinde reddet. Normal dönemde net/brüt
tanımını eşitle (`ceil(net × bps / (10_000 − bps))`). Testleri 0/1/19/20. saniye, iki currency sırası,
dört swap yönü ve kısmi gerçekleşme için yaz.

**Kısıt:** Hook adresi factory'de bir kez atanıyor ve upgrade yolu yok. Bu düzeltme **yeni bir
factory + hook sürümü** demek; mevcut havuzlara uygulanamaz.

### A2 — "Havuzdaki tüm likidite kilitli" ifadesi yanlış · **Doğrulandı** · metin düzeltmesi, bugün yapılabilir

`StockPairHook.sol:87-90`: `beforeAddLiquidity: false`, `beforeRemoveLiquidity: false`. Hook likidite
işlemlerini kapılamıyor, dolayısıyla **herhangi biri kendi v4 pozisyonunu ekleyip çıkarabilir**.

Doğru olan: *factory'nin* pozisyonu çekilemez (`modifyLiquidity` yalnızca `unlockCallback` içinde ve
yalnızca pozitif delta ile çağrılıyor). Yanlış olan: "havuzun tamamı kilitli".

Şu an yanlış söyleyen yerler:

- `app-shell.tsx` footer: "a Uniswap v4 pool … whose liquidity can never be removed"
- Hazırladığım tweet taslakları: "no function exists that can remove that liquidity"

`docs/page.tsx` zaten doğru yazıyor ("held by the factory").

**Yapılacak:** İfadeyi "arzın tamamı factory'nin çekilemeyen pozisyonunda" diye düzelt. Likidite
rakamını da factory pozisyonu ile diğer pozisyonlar olarak ayrı hesapla — bugünkü gösterim yalnızca
factory pozisyonundan türüyor ve haricî LP varsa eksik kalır.

### A3 — `addSwapFees` ücreti çift sayıyor · **Doğrulandı** · sadece indexer, hemen yapılabilir

`packages/core/src/db/queries.ts:332-353`. Fonksiyon önce `(tx_hash, pool_id)` başına toplamı
çıkarıyor, sonra o çifte uyan **her satırı** güncelliyor:

```sql
UPDATE swaps s SET fee_stock_raw = s.fee_stock_raw + v.fee
WHERE s.tx_hash = v.tx_hash AND s.pool_id = v.pool_id
```

Bir işlemde aynı havuzdan iki swap geçerse (`log_index` farklı, `tx_hash`+`pool_id` aynı) ikisine de
**tam toplam** yazılır: 3 + 4 = 7, iki satıra da 7 → 14.

Üstelik `+=` olduğu için **idempotent değil**. `swaps` insert'ü `ON CONFLICT DO NOTHING` ile korunmuş,
ama ücret güncellemesi korunmamış. Aynı aralık rollback olmadan iki kez sync edilirse (çökme sonrası
replay) ücretler yeniden eklenir.

**Yapılacak:** Eşleştirmeyi `log_index` ile yap, ücreti kendi swap'ine bağla. Ya da `fee_stock_raw`'ı
`+=` yerine mutlak değer olarak yaz. `fee_events` tablosu ayrı yazıldığı için oradaki toplamlar
etkilenmiyor — yani platform/creator gelir rakamları doğru, bozuk olan işlem satırındaki ücret.

### A4 — `/api/metadata` kimliksiz ve sınırsız · **Doğrulandı** · hemen yapılabilir

`apps/web/app/api/metadata/route.ts`. Kimlik doğrulama yok, hız sınırı yok (`rateLimit|limiter|throttle`
araması tüm `apps/web`'de boş dönüyor), çağrı başına 2 MB'a kadar dosyayı Pinata hesabımıza pinliyor.
`proxy.ts` yalnızca ülke bazlı engelliyor.

Kötü niyet gerekmez; tek bir hatalı döngü kotayı tüketir ve o hesap **bütün tokenlerin logolarını**
sunuyor.

**Yapılacak:** IP başına hız sınırı, günlük toplam tavan, ve tercihen launch akışına bağlı bir nonce.

---

## B. Yakında yapılması gerekenler

### B1 — Launch imzasında deadline ve kabul edilen fiyat yok · **Doğrulandı**

`StockPairFactory.sol:44-50`: `LaunchParams { name, symbol, contractURI, stock, salt }`. Ne deadline
var ne kabul edilen açılış fiyatı/FDV. `msg.value == creationFee` yalnızca ücret değişimini yakalar.

Kullanıcı işlemi imzaladıktan sonra owner FDV'yi değiştirirse veya feed yenilenirse, işlem
kullanıcının görmediği bir fiyatla gerçekleşir.

**Yapılacak:** `deadline`, `expectedConfigVersion` ve kabul edilen açılış fiyatı sınırları ekle.
Yeni sürüm işi, A1 ile birlikte gitmeli.

### B2 — Feed yaşı 7 gün, pause durumu okunmuyor · **Doğrulandı**

`StockPairFactory.sol:87` `MAX_FEED_AGE = 7 days`, kontrol `:423`. Yalnızca pozitif fiyat, gelecek
olmayan timestamp ve yaş bakılıyor; corporate-action pause okunmuyor.

**Yapılacak:** Oracle registry'den pause durumunu oku (`0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD`).
Yaşı da hafta sonu launch'larını yanlışlıkla engellemeyecek şekilde stock bazında değerlendir.

### B3 — `feedStatus()` 3 saatte "paused" diyor · **Kısmen** · bugün yapılabilir

`apps/web/lib/market-view.ts:48-54`. 3 saatten eski her fiyat `paused`. Belgelenen heartbeat 24 saat;
sapma olmadığı için güncellenmeyen sağlıklı bir feed yanlışlıkla "paused" görünebilir.

Raporun çekirdeği doğru: etiket yalnızca yaştan türetiliyor ve "güncel okuma yok" ile "oracle
durduruldu" birbirine karışıyor. Pratikte ABD seansında NVDA 3 saatte %0.5 hareket ettiği için yanlış
etiket nadir; ama isimlendirme yine de yanlış.

**Yapılacak:** Durumu ayrı alanlara böl — son güncelleme zamanı, feed sağlığı, oracle pause, transfer
pause, piyasa takvimi. Bilinmeyen için `unknown` kullan, `paused` deme.

### B4 — Token sayfasındaki claim geliri o tokene ait değil · **Doğrulandı** · bugün yapılabilir

`apps/web/lib/token.server.ts:51-57` → `claimable[stock][creator]`. Bu, o creator'ın **o stock'a
bağlı bütün tokenlerinin** ortak bakiyesi. Bizim creator'ın NVDAc'de 6 tokeni var, dolayısıyla STOCK
sayfasında görünen rakam altısının toplamı.

**Yapılacak:** Ya etiketi "bu creator'ın NVDAc'deki toplam claim'i" diye düzelt, ya da token bazlı
pay `fee_events`'ten hesaplanıp ayrı gösterilsin.

### B5 — Indexer: log blockHash'i canonical blokla karşılaştırılmıyor · rapor bulgusu, yerel testle üretilmiş

Loglar alındıktan sonra blok değişirse eski log yeni blok hash'iyle yazılabiliyor. Raporun kendi
hedefli testinde yetim launch kaydı kalmış ve sonraki sync geri almamış.

**Yapılacak:** Her logun kendi `blockHash`'ini okunan canonical blokla karşılaştır, uyumsuz batch'i
yazma. A3'teki idempotency düzeltmesiyle birlikte ele alınmalı — ikisi aynı çökme senaryosuna bakıyor.

### B6 — Metadata indirme ana döngüyü bekletiyor

`apps/indexer/src/metadata.ts` + `main.ts:91`. Backfill idle poll'da limit 5 ile çağrılıyor, kalıcı
başarısızlıklar `metadata_fetched_at` boş kaldığı için **her poll'da** yeniden deneniyor, geri çekilme
yok. Bu hem zincir takibini bekletir hem de logolarımızı sunan gateway'de rate-limit yemeye yol açar.

**Yapılacak:** Ayrı kuyruk, deneme sayacı, üstel geri çekilme, byte sınırı.

---

## C. Böyle kalabilir, ama bilinerek

- **Creator anti-snipe ücretinin %70'ini geri alabiliyor** (`StockPairHook.sol:_charge`). Doğrulandı:
  bölüşüm `feeBps`'ten bağımsız. Bu bir açık değil, teşvik tercihi. Değiştirmek istersen creator
  payını yalnızca taban ücrete uygula — yine yeni hook demek.
- **Treasury değişimi mevcut havuzların gelecekteki platform ücretlerini de yönlendirir.** Hook her
  swap'te factory'den okuyor. Operasyonel tercih; belgelenmeli ve çoklu imzaya bağlanmalı.
- **Stock transfer pause swap ve claim'i durdurabilir.** `claimMany` içinde tek bir stock revert
  ederse paket tümden geri döner. Arayüzde anlaşılır gösterilmeli.
- **`tokens()` görünümü büyüyor.** Sayfalama gerekir ama acil değil.
- **Oluşturma ücreti doğrudan treasury'ye gidiyor;** treasury ETH kabul etmezse tüm launch'lar revert
  eder. Dağıtımda doğrulanmalı.

---

## D. Raporun artık geçerli olmayan kısımları

- **Geçmiş USD mumları** (rapor §4): **Zaten düzeltildi**, commit `5ac73d4`. Mumlar artık
  `stock_quote_history`'den her mumun kendi anındaki fiyatıyla değerleniyor ve dönüşüm
  toplulaştırmadan önce yapılıyor. Canlıda 244 mum 10 farklı hisse fiyatı kullanıyor.
- **Rapor 84 TypeScript testi görmüş**; şu an 86+ ve migration, market totals, quote history, cache
  için yeni testler var.

---

## E. Rapor dışı, bu oturumda bulunanlar

- **B20 tokenleri doğrulanamaz.** `eth_getCode` bizim token için `0xef`, Coinbase'in NVDAc'si için de
  `0xef` (normal ERC-20: 11.608 bayt). Precompile destekli oldukları için kaynak kodu yok. "Kontrat
  doğrulanmış olmalı" diyen hiçbir mecra (BaseScan dahil) B20'leri listeleyemez — bize özel değil.
- **DexScreener logoyu zincirden okumuyor.** Kendi CMS'i; ya CoinGecko listelerinden otomatik ya da
  ücretli formdan. `contractURI` hiçbir işe yaramıyor.
- **`contractURI` launch'ta donuyor** (`B20Encoding.sol:23`, `initialAdmin = address(0)`). Mevcut
  tokenlerin metadata'sı düzeltilemez; pipeline iyileştirmeleri yalnızca yeni launch'lara yarar.
- **Tek Pinata hesabı, ikinci kopya yok.** Hesap düşerse bütün logolar ölür.

---

## Sıra

1. **A3, A4, A2-metin, B3, B4** — hepsi mevcut kod içinde, kontrat değişikliği yok, bugün yapılabilir.
2. **B5, B6** — indexer bütünlüğü ve dayanıklılık.
3. **A1 + B1 + B2** — birlikte, tek bir V2 factory/hook sürümü olarak. Ayrı ayrı deploy etmenin
   anlamı yok çünkü her biri yeni bir dağıtım gerektiriyor.
4. Yük testi ve B20 native entegrasyon testleri.

**V2 geçiş sınırı:** Hook adresi bir kez atanıyor, upgrade mekanizması yok, eski kilitli LP'yi taşıyan
bir yol da yok. V2 çıkarsa eski ve yeni dağıtımlar ayrı sürüm olarak indexlenmeli, eski token
sayfaları ve claim yolları yaşatılmalı, ve eski havuzların yeni kontratla düzeldiği izlenimi
verilmemeli.
