# /int — stüdyo içi alan

Bu klasördeki sayfalar halka açık sitenin parçası değildir. `deltaxgames.com/int/*` yolunu
Cloudflare Access korur: yalnızca izin listesindeki e-postalar girebilir.

| Yol | Ne |
|---|---|
| `int/finance_dashboard/` | DeltaX Financial Tracker (statik sayfa, GitHub Pages sunar) |
| `int/production_plan/` | Üretim planı ilerleme sayfası: her görev için yeşil tik / kırmızı X (statik sayfa; veri API'den gelir) |
| `int/api/` | Veri API'si: Cloudflare Worker + D1. Worker GitHub'a **bağlı değildir**: `src/index.js` kaynak kopyadır, kod Cloudflare panelinde elle yapıştırılıp dağıtılır (bkz. "Worker kodunu güncelleme") |

Veri repoda **durmaz**; D1 veritabanındadır. Repo herkese açık olduğu için buraya hiçbir
gerçek rakam, e-posta listesi ya da gizli değer yazılmaz.

## Bir kerelik kurulum

### 1. Alan adını Cloudflare'a al
1. Cloudflare panelinde **Add a domain** → `deltaxgames.com` → Free plan.
2. Cloudflare bulduğu DNS kayıtlarını listeler. Squarespace DNS panelindeki **tüm** kayıtlarla karşılaştır,
   özellikle e-posta (MX, TXT/SPF, DKIM) kayıtları eksiksiz olsun. GitHub Pages için:
   `A @ → 185.199.108.153 / 109.153 / 110.153 / 111.153` (Proxy: **açık**), `CNAME www → firatdeltax.github.io` (Proxy: açık).
3. Squarespace'te alan adının nameserver'larını Cloudflare'ın verdiği iki adresle değiştir. Yayılması birkaç saat sürebilir.
4. Cloudflare → **SSL/TLS** → Encryption mode: **Full**. GitHub repo ayarlarında Pages → Enforce HTTPS açık kalsın.

### 2. Access uygulaması (giriş)
1. Cloudflare → **Zero Trust** (ilk girişte bir takım adı seçilir; `<takım>.cloudflareaccess.com` olur).
2. **Access → Applications → Add an application → Self-hosted**.
   - Application name: `DeltaX Internal` (`/int` altındaki her şeyi korur: finans, üretim planı, API)
   - Domain: `deltaxgames.com`, Path: `int`  (→ `deltaxgames.com/int/*`)
   - Session duration: 1 week
   - Identity providers: **One-time PIN** (e-postaya kod gelir). İstenirse Google da eklenir.
3. **Policy**: Name `Partners`, Action **Allow**, Include → **Emails** → izin verilecek adresler.
   Listeyi ileride burada güncellersin; kod değişikliği gerekmez.
4. Kaydet. Uygulamanın **Overview** sekmesindeki **Application Audience (AUD) Tag** değerini kopyala.

### 3. D1 veritabanı
1. Cloudflare → **Workers & Pages → D1 → Create** → ad: `deltax-finance`.
2. Veritabanının **Console** sekmesine `int/api/schema.sql` içeriğini yapıştır, çalıştır.
3. **Database ID**'yi kopyala, `int/api/wrangler.toml` içindeki `database_id` satırına referans olarak yaz (panele uygulanmaz; Worker'a bağlama adım 4'te).

### 4. Worker'ı oluştur (kod elle yapıştırılır)
Worker GitHub'a bağlı değildir; bu repo yalnızca kaynak kopyayı ve testleri tutar. `wrangler.toml` panele **uygulanmaz**,
içindeki binding, route ve cron değerleri panelde elle tanımlanır.
1. Cloudflare → **Workers & Pages → Create → Worker** (boş bir Worker; paneldeki adı serbesttir, bugünkü Worker `muddy-math-d5d1`).
2. **Edit code** → `int/api/src/index.js` dosyasının tamamını yapıştır → **Deploy** (bkz. "Worker kodunu güncelleme").
3. **Settings → Bindings**: D1 database, değişken adı `DB` (tam böyle), veritabanı `deltax-finance`.
4. **Settings → Variables and Secrets** → üç **Secret** ekle:
   - `ACCESS_TEAM_DOMAIN` = `<takım>.cloudflareaccess.com`
   - `ACCESS_AUD` = adım 2'deki AUD etiketi
   - `ADMIN_EMAILS` = yönetici e-postaları, virgülle (hesap, kategori, kur, içe aktarma yetkisi)
5. Route `deltaxgames.com/int/api/*` ve cron `0 13 * * MON-FRI` (`wrangler.toml` içindeki değerler) panelde tanımlı olmalı.
   `workers.dev` adresi kapalı kalmalı.

### Worker kodunu güncelleme (elle)
`int/api/src/index.js` değişince (PR `main`'e girdikten sonra) Worker kendiliğinden güncellenmez:
1. Mac'te Terminal'de, **başka hiçbir şey kopyalamadan**:
   `curl -s https://raw.githubusercontent.com/firatdeltax/deltaxgames-site/main/int/api/src/index.js | pbcopy`
   Türkçe karakterler bozuk çıkarsa kabuğun UTF-8 yerel ayarı yoktur: `LC_ALL=en_US.UTF-8 pbcopy` kullan.
   Kontrol: `LC_ALL=en_US.UTF-8 pbpaste | wc -c` dosyanın bayt sayısını vermeli.
2. Cloudflare → Workers & Pages → Worker → **Edit code** → tümünü seç, yapıştır → **Deploy**.
   Dosyanın ilk satırı `/*`, son işlevi `newDocId` olmalı. "requires a Worker written in ES module format" hatası
   yapıştırmanın bozuk olduğunu gösterir.
3. Giriş yapmışken `https://deltaxgames.com/int/api/plan/current` adresini aç: `{"error":"Kayıt yok",...}` ya da veri gelmeli.
   Sorun olursa **Deployments** sekmesinden önceki sürüme dönülür.

### 5. Veriyi aktar ve dene
1. Tarayıcıda `https://deltaxgames.com/int/finance_dashboard/` → e-posta → kod → sayfa açılır.
2. **Ayarlar → JSON içe aktar** ile eski verinin `import.json` dosyasını yükle (Claude hazırlar; repoya konmaz).
3. Listede olmayan bir e-postayla dene: Access "erişim yok" göstermeli.
4. Ayarlar → **Kurları şimdi güncelle**: Worker TCMB'ye erişebiliyor mu, bakarsın. Sonrası her iş günü otomatik.

## Nasıl çalışır
- Tarayıcı `/int/finance_dashboard/` ister → Access araya girer, giriş ister → sayfa GitHub Pages'ten gelir.
- Sayfa `/int/api/...` adreslerine istek atar → Worker, Access'in eklediği JWT'yi Access sertifikalarıyla
  doğrular, e-postayı okur, D1'e yazar/okur. `workers.dev` adresi kapalıdır; Worker'a Access dışından ulaşılamaz.
- `firatdeltax.github.io/int/finance_dashboard/` adresi Access'in arkasında değildir: orada yalnızca boş sayfa
  görünür, API'ye ulaşamadığı için veri göstermez. Sayfa `noindex`'tir ve robots.txt `/int/` yolunu kapatır.
- Yönetici (ADMIN_EMAILS) hesap, kategori, kur ve ayarları değiştirir; diğer izinli kişiler işlem girer.

## Yerelde deneme
Worker için Node ve `npx wrangler dev` gerekir. Sadece sayfayı denemek için küçük bir sahte API yeterli;
Claude bu amaçla Python ile bir mock sunucu kullandı. Gerçek doğrulama Cloudflare'da yapılır.

## Üretim planı sayfası (`int/production_plan/`)

Her görev için büyük yeşil **tik** (bitti) ya da kırmızı **X** (henüz değil) gösteren ilerleme sayfası.

- Sayfa statiktir; veriyi `GET /int/api/plan/current` verir (D1, `plan` koleksiyonu, tek belge `current`).
  Veri repoda **durmaz**: repo herkese açık, plan yalnızca Access'ten geçenlere görünür.
- Veriyi oyun reposundaki `tools/website/plan-status.py` üretir: `production/production-plan.md` dosyasını
  `origin/develop` üzerinden okur, her görevi done / progress / todo olarak sınıflar ve bir önceki yayına göre
  değişenleri "Recent changes" kutusuna yazar. Plan 100 satırdan az çıkarsa ya da öncekinden %20'den fazla
  küçülürse yayınlamaz.
- Her gece 03:00 testinden önce (02:30) bir iş `plan-status.py --fetch --push` çalıştırır: önce casper'da
  (Windows kutusu), olmazsa Mac'te. Sayfa 36 saatten eski veriyi "güncellenmedi" diye işaretler.
- Sayfadaki "Who is working on what" bölümü iki karttır (Görkem, Fırat; adlar `int/production_plan/index.html` içindeki
  `PEOPLE` listesindedir). "Right now" notunu Access'ten geçen herkes sayfadan **Edit** ile yazar; `plan/people`
  belgesine PUT edilir (yalnızca bu belge ve yalnızca PUT herkese açıktır; silmek ve `plan/current` yönetici işi,
  eşzamanlı kayıtta `if_version` ile 409). Kartın altındaki liste plandaki "In progress" satırlarından, Owner sütununda
  adı geçenlerden otomatik gelir; "Dev" (yapay zekâ hatları) satırları listelenmez.
- Yönetici elle de yükleyebilir: sayfadaki "Admin" kutusundan `plan-status.py --out plan.json` çıktısı seçilir.
- Sayfayı Access izin listesindeki herkes görür, finans sayfasıyla aynı liste. Finans verisini görmemesi gereken
  biri listeye eklenecekse önce Worker'da finans koleksiyonlarına e-posta kısıtı eklenmelidir.

### Bir kerelik kurulum (gece işi için servis anahtarı)

1. Zero Trust → **Access → Service credentials → Create Service Token**: ad `plan-nightly`, süre **1 yıl** (son kullanma tarihini not et: dolunca yeni anahtar üret, `plan-job.sh set-token` ve `PLAN_SERVICE_ID` yenilenir).
   **Client ID** ve **Client Secret** yalnızca bir kez gösterilir; kopyala.
2. **Access controls → Policies → Add a policy**: ad `Plan bot`, Action **Service Auth**,
   Include → **Service Token** → `plan-nightly` (**Any Access Service Token** seçme). Sonra **Access controls → Applications →
   DeltaX Internal → Policies → Add existing policy → Plan bot → Save**. (Mevcut "Partners" Allow politikası olduğu gibi kalır.)
   Kontrol: Reusable policies listesinde Plan bot'un "Used by applications" değeri 1 olmalı.
3. Worker → **Settings → Variables and Secrets** → Secret `PLAN_SERVICE_ID` = Client ID (`....access` ile biten
   metnin tamamı). Panelden eklenince Worker yeni sürümle dağıtılır.
4. Oyun reposunda `tools/website/plan-job.sh set-token` (Client ID ve Secret sorulur; casper'daki
   `%USERPROFILE%\.config\deltax\plan-token.json` dosyasına yazılır, repoya girmez), sonra `plan-job.sh install`,
   `plan-job.sh dry-run`, `plan-job.sh now` → `published plan/current ...`. (Mac'ten elle: `python3 tools/website/plan-status.py --fetch --push`,
   anahtar `~/.config/deltax/plan-token.json` içinde.)
5. Her gece 02:30'da casper'daki görev `SivasPlanPublish` çalışır; başarısız olursa telefona bildirim gider.
   Servis anahtarı yalnızca `GET/PUT /int/api/plan/current` yapabilir; Worker başka her uç noktada 403 verir
   (`int/api/test/plan-access.test.mjs`).
