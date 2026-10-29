# /int — stüdyo içi alan

Bu klasördeki sayfalar halka açık sitenin parçası değildir. `deltaxgames.com/int/*` yolunu
Cloudflare Access korur: yalnızca izin listesindeki e-postalar girebilir.

| Yol | Ne |
|---|---|
| `int/finance_dashboard/` | DeltaX Financial Tracker (statik sayfa, GitHub Pages sunar) |
| `int/api/` | Veri API'si: Cloudflare Worker + D1. Cloudflare "Workers Builds" bu klasörü her push'ta dağıtır |

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
   - Application name: `DeltaX Finance`
   - Domain: `deltaxgames.com`, Path: `int`  (→ `deltaxgames.com/int/*`)
   - Session duration: 1 week
   - Identity providers: **One-time PIN** (e-postaya kod gelir). İstenirse Google da eklenir.
3. **Policy**: Name `Partners`, Action **Allow**, Include → **Emails** → izin verilecek adresler.
   Listeyi ileride burada güncellersin; kod değişikliği gerekmez.
4. Kaydet. Uygulamanın **Overview** sekmesindeki **Application Audience (AUD) Tag** değerini kopyala.

### 3. D1 veritabanı
1. Cloudflare → **Workers & Pages → D1 → Create** → ad: `deltax-finance`.
2. Veritabanının **Console** sekmesine `int/api/schema.sql` içeriğini yapıştır, çalıştır.
3. **Database ID**'yi kopyala, `int/api/wrangler.toml` içindeki `database_id` satırına yaz, commit et.

### 4. Worker'ı repoya bağla
1. Cloudflare → **Workers & Pages → Create → Import a repository** → GitHub'ı bağla → `firatdeltax/deltaxgames-site`.
2. Build ayarları: **Root directory** `int/api`, Build command boş, **Deploy command** `npx wrangler deploy`.
3. Worker oluşunca **Settings → Variables and Secrets** → üç **Secret** ekle:
   - `ACCESS_TEAM_DOMAIN` = `<takım>.cloudflareaccess.com`
   - `ACCESS_AUD` = adım 2'deki AUD etiketi
   - `ADMIN_EMAILS` = yönetici e-postaları, virgülle (hesap, kategori, kur, içe aktarma yetkisi)
4. **Settings → Triggers**: Route `deltaxgames.com/int/api/*` ve cron `0 13 * * MON-FRI` görünmeli (wrangler.toml'dan gelir).
   Görünmüyorsa "Deployments" sekmesinden yeniden dağıt.

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
