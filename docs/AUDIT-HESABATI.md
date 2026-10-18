# AEEC — vahid layihə: dəyişikliklər və yoxlama hesabatı

18.10.2026 · panel 1.2, sayt v3.2

## 1. Nə dəyişdi (1.1 → 1.2)

| Əvvəl (1.1) | İndi (1.2) |
|---|---|
| İki qovluq: `site/` (Apache verirdi) və `app/` (Node). Panel saytı `SITE_DIR` ilə kənar qovluqda (`/var/www/html`) axtarırdı | Bir layihə qovluğu. Sayt `site/` layihənin içindədir, onu tətbiqin özü verir. `SITE_DIR`, `SERVE_SITE`, `SITE_PUBLISH`, `DATA_DIR`, `ENV_FILE`, `SITE_URL` ayarları **ləğv edildi** |
| Saytın qaydaları Apache `.htaccess`-də idi (keçidlər, başlıqlar, 404) | Eyni qaydalar `src/site-static.js`-də; `.htaccess` silindi. Bütün yönləndirmələr eyni saytın daxili yollarıdır |
| Lokal sınaq üçün ayrıca `npm run dev`, canlıda Apache + Node — iki ayrı xidmət | Hər yerdə bir əmr: `npm start` → `http://localhost:8080/` sayt, `/admin/` panel |
| İlk admin üçün `.env` faylında şifrə yazmaq məcburi idi | `.env` lazım deyil: ilk işə salınmada müvəqqəti şifrə yaradılır (ekranda və `data/ilk-giris.txt`, yalnız server istifadəçisi oxuya bilər); şifrə dəyişəndən sonra fayl özü silinir |
| Paneldəki «Sayta bax» / «Saytda bax» keçidləri tam domen ünvanına (`https://aeec.az`) gedirdi | Daxili keçidlər: `/` və `/xeberler/` — lokalda da, serverdə də eyni tətbiqin içində qalır |
| Canlıda Apache faylı yalnız `/admin`, `/api`, `/media`-nı ötürürdü, saytı özü verirdi | `deploy/apache-aeec.conf` hər şeyi tətbiqə ötürür (bir `Include` sətri); Apache-də DocumentRoot/.htaccess artıq istifadə olunmur |
| Yeniləmədə xəbər qovluqlarına toxunmamaq lazım idi | Yeniləmə: qovluğu üzərinə yazmaq, yalnız `data/` və `.env` saxlanılır; xəbər səhifələri bazadan avtomatik bərpa olunur |
| `upgrade-insecure-requests` həmişə | Yalnız HTTPS canlı rejimdə (lokal `http://localhost`-da şəkil/skriptlər pozulmasın) |
| `sendmail` standart olaraq aktiv idi | Söndürülüb; e-poçt SMTP ilə (istəyə bağlı `SENDMAIL_PATH`) |

Dəyişməyənlər: saytın dizaynı, mətnləri, 3 dili, formaları, xəbərləri (generator orijinal
səhifələri bayt-bayt eyni yaradır), köhnə ünvanların keçidləri, panelin bütün funksiyaları.

## 2. Kənar ünvanlar barədə

- Layihədə başqa domenə **yönləndirmə yoxdur**. Naviqasiya keçidlərinin hamısı nisbidir (`/…`).
- Səhifələrin başlığındakı `https://aeec.az/…` ünvanları (canonical, hreflang, og:url, sitemap)
  yönləndirmə deyil, axtarış sistemləri üçün məlumatdır; saytın öz domenidir və SEO üçün
  mütləq ünvan olmalıdır. Lokal işə salınmada brauzer onlara getmir (testlə yoxlanılıb).
- Saytın əvvəldən istifadə etdiyi kənar xidmətlər məzmunun hissəsidir və dəyişdirilmədi:
  Google Fonts (şrift), Əlaqə səhifəsində Google Maps xəritəsi, LinkedIn/Facebook keçidləri.

## 3. Yoxlama — real icra olunanlar

| Test | Nəticə |
|---|---|
| `npm test` — 23 avtomatik test; layihənin müvəqqəti surətində işləyir (əsl `site/`, `data/` dəyişmir) | 23/23 |
| Sıfır ayarla işə salma: layihənin təmiz surətində `npm start`, `.env` yox. Sayt, köhnə ünvan, forma, ilk giriş (yaradılmış şifrə ilə) → şifrə dəyişmə → fayl silinir → xəbər yazıldı → saytda göründü; brauzer konsolunda xəta yox; `localhost`-dan başqa hosta (Google şriftləri istisna) sorğu yox | Keçdi |
| Bütün daxili keçidlər: 40 səhifə, 1129 keçid/şəkil/skript/stil, sitemap və hreflang ünvanları; 30 köhnə `.html` ünvanı | Hamısı düzgün |
| Brauzer testi canlı rejimdə (`BASE_URL=https://aeec.az`, HTTPS sınaq proxy-si Cloudflare+Apache rolunda): sayt kompüter + telefon, 3 forma (AZ/EN/RU), statistika, giriş/səhv şifrə/çıxış/səhifəni yeniləmə/sessiyanın bitməsi/dərin keçid/başqa ünvana yönləndirmə cəhdi, xəbər dərci və arxiv, panelin 21 bölməsi, telefon görünüşü | Keçdi |
| Panelin tam funksional ssenarisi (media, redaktor, sorğular, eksport, istifadəçilər, 2FA, rollar, nüsxə, audit) | Keçdi |

## 4. Real test edilməyənlər

- Real Apache və Cloudflare (bu mühitdə Apache quraşdırıla bilmir). `deploy/apache-aeec.conf`
  serverdə `apache2ctl configtest` ilə yoxlanmalıdır (OXU-MENI.txt, 5-ci addım).
- systemd xidməti real Ubuntu-da; real SMTP serveri ilə məktub; Safari/Firefox; Windows-da
  `npm start` (yalnız Linux-da yoxlanılıb).

## 5. Hələ statik qalanlar

Layihələr, Həllər, Haqqımızda, Əlaqə səhifələri `site/` içində HTML fayllarıdır; paneldəki
Layihələr / Xidmətlər / Komanda / Şirkət bölmələrinin məlumatı onlara avtomatik düşmür (panel
bunu həmin bölmələrdə yazır). Növbəti mərhələdə xəbərlərdəki kimi şablonla qoşula bilər.
