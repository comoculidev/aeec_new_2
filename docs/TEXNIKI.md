# AEEC — sayt, panel və API: texniki sənəd

Versiya 1.2 (sayt v3.2) · proqramçı və sistem inzibatçısı üçün.

## 1. Arxitektura

Bir layihə qovluğu, bir proses, bir port. Sayt da, panel də, API də eyni Node.js tətbiqidir.

```
Brauzer ──► [canlıda: Cloudflare → Apache (yalnız ötürür, deploy/apache-aeec.conf)]
        ──► server.js (Node.js, PORT=8080)
              ├─ /admin/, /admin/login, /admin/assets/*   → admin/
              ├─ /api/*                                    → src/routes/*
              ├─ /media/*                                  → data/uploads/
              └─ qalan hər şey                             → site/   (src/site-static.js)
                                                             ▲
              xəbər generatoru (src/site-news.js) ───────────┘ site/xeberler, en/news, ru/news,
                                                               assets/img/cms, sitemap.xml
              data/ ── aeec.sqlite · uploads/ · private/ · backups/ · secret.key · ilk-giris.txt
```

Bütün yollar layihə qovluğuna nisbətəndir (`src/config.js`: `site/`, `data/`, `.env`); layihədən
kənar qovluğu göstərən heç bir ayar yoxdur. Saytın əvvəl Apache `.htaccess`-də olan qaydaları
(köhnə ünvanların 301 keçidləri, `index.html` → qovluq, qovluq → `/` ilə, gizli/xidməti
faylların bağlanması, CSP və digər başlıqlar, keş, gzip, 404 səhifəsi) indi
`src/site-static.js`-dədir. Bütün yönləndirmələr eyni saytın daxili yollarıdır.
`BASE_URL` (yalnız canlıda) verilibsə, `www.` və `http` sorğuları həmin ünvana keçirilir.

- **Dil / mühit:** Node.js 22 (≥ 22.13). **Xarici kitabxana yoxdur** — yalnız Node-un
  daxili modulları (`node:http`, `node:sqlite`, `node:crypto`, `node:zlib`). Bu, quraşdırmanı
  sadələşdirir və üçüncü tərəf paketlərindən gələn riskləri aradan qaldırır.
- **Verilənlər bazası:** SQLite (WAL rejimi). İlkin planda PostgreSQL nəzərdə tutulmuşdu;
  hazırlanma mühitində yalnız SQLite tam sınaqdan keçirilə bildiyi üçün o seçildi. Bu ölçüdə
  sayt üçün tam kifayətdir; bütün SQL `src/` daxilində toplanıb və sxem standart SQL-dir,
  ona görə gələcəkdə PostgreSQL-ə köçürmə mümkündür.
- **Frontend:** çərçivəsiz (vanilla) JavaScript modulları, qurma (build) mərhələsi yoxdur.
- **API:** REST, JSON. Səhv cavabı: `{ "error": { "code", "message", "fields" } }`.

## 2. Qovluq quruluşu

| Yol | Məzmun |
|---|---|
| `server.js` | Giriş nöqtəsi, marşrutların qoşulması, fon işləri |
| `src/config.js` | Ayarlar (`.env` istəyə bağlıdır); bütün yollar layihə daxilində |
| `src/db.js` | Baza bağlantısı, **sxem və miqrasiyalar** |
| `src/http.js` | Marşrutlaşdırma, sorğu gövdəsinin oxunması (ölçü limiti), təhlükəsizlik başlıqları, fayl ötürülməsi |
| `src/security.js` | scrypt, TOTP, sorğu limitləri |
| `src/auth.js` | Sessiya, CSRF, icazə yoxlaması |
| `src/validate.js` | Giriş məlumatlarının yoxlanması |
| `src/crud.js` | Ümumi siyahı / yaratma / redaktə / silmə / eksport |
| `src/files.js` | Fayl yükləmə qaydaları |
| `src/markdown.js` | Mətn formatının təhlükəsiz HTML-ə çevrilməsi |
| `src/mail.js`, `src/notify.js` | SMTP, bildirişlər |
| `src/analytics.js` | Ziyarət sayğacı və hesabatlar |
| `src/backup.js`, `src/xlsx.js` | Ehtiyat nüsxə, Excel/CSV |
| `src/routes/*.js` | API ünvanları (auth, public, content, files, requests, admin) |
| `src/site-news.js` | Xəbərlərin saytın statik səhifələrinə çevrilməsi, ilk işə salınmada mövcud xəbərlərin idxalı |
| `src/site-static.js` | Saytın verilməsi və onun qaydaları (keçidlər, başlıqlar, keş, gzip, 404) |
| `src/imagesize.js`, `src/proxycheck.js` | Şəkil ölçüsü; proxy/IP ayarının yoxlanması |
| `site-templates/` | Xəbər səhifələrinin şablonları (v3.1 səhifələrindən hazırlanıb) |
| `admin/` | Panelin interfeysi |
| `site/` | Sayt. `site/assets/js/main.js` — saytın skripti: formalar → `/api/public/form`, statistika → `/api/public/collect` |

Ünvanlar: `/` sayt · `/admin/` panel (sessiya yoxdursa 302 → `/admin/login`) ·
`/admin/login` giriş (sessiya varsa 302 → `/admin/`) · `/admin` və `/admin/login/` → 301 ·
`/admin/*` digər → 404 · `/api/*` JSON (tapılmayan → 404 JSON) · `/media/*` paneldən yüklənən
açıq fayllar. Girişdən sonra qayıdış yalnız panel daxilindəki `#/marşrut`-a ola bilər
(`safeNext`), parametr və ya başqa host qəbul edilmir.

## 3. Verilənlər bazası

| Cədvəl | Təyinat | Əlaqələr |
|---|---|---|
| `users` | İstifadəçilər | `role_id → roles` |
| `roles`, `permissions`, `role_permissions` | Rollar və modul əsaslı icazələr | çoxun-çoxa |
| `sessions`, `password_resets` | Sessiyalar (yalnız nişanın heşi), bərpa nişanları | `user_id → users` (silinəndə silinir) |
| `news` | Xəbərlər | `cover_media_id → media`, `created_by → users` |
| `projects` | Layihələr | `main_media_id → media`; `documents`, `gallery` — ID siyahıları |
| `services` | Xidmətlər | `image_media_id → media` |
| `team_members` | Komanda | `photo_media_id → media` |
| `project_requests` | «Layihənizi müzakirə edək» müraciətləri | `assigned_to → users` |
| `project_request_files` | Müraciətə əlavə olunan fayllar | `request_id`, `media_id` |
| `contact_requests` | Əlaqə müraciətləri | — |
| `request_notes` | Qeydlər və tarixçə (status, təyinat, e-poçt) | `request_type` + `request_id` |
| `analytics_sessions`, `page_views` | Ziyarətlər və səhifə baxışları | `session_id` |
| `analytics_salts` | Gündəlik təsadüfi açar (2 gündən sonra silinir) | — |
| `media` | Bütün fayllar (`is_private` — sənəd və əlavələr) | `uploaded_by → users` |
| `documents` | Sənədlər | `file_media_id → media` |
| `notifications` | Bildirişlər (hər istifadəçi üçün ayrıca) | `user_id → users` |
| `audit_logs` | Audit jurnalı — **UPDATE və DELETE baza triggeri ilə qadağandır** | — |
| `settings` | Tənzimləmələr (qrup üzrə JSON) | — |
| `seo_pages` | Səhifələrin SEO məlumatı | `og_image_media_id → media` |
| `site_files` | Panelin saytda yaratdığı («idarə etdiyi») fayllar və heşləri | — |
| `site_meta` | İdxal bayrağı, son generasiyanın nəticəsi | — |
| `backups`, `outbox` | Nüsxələrin siyahısı, göndəriləcək məktublar | — |

Çoxdilli sahələr: əsas dəyər Azərbaycan dilindədir, tərcümələr `i18n` sütununda
`{ "en": {…}, "ru": {…} }` kimi saxlanılır; boş tərcümə API-də AZ dəyəri ilə əvəz olunur.
Xəbərlərdə isə başlıq və ya tam mətn tərcüməsi yoxdursa, həmin dildə səhifə yaradılmır.
`news.slug_en`, `news.slug_ru` — EN/RU səhifə ünvanları; `news.site_image` — saytdakı
mövcud şəkil (`/assets/img/…`), `news.cover_alt` — şəklin alt mətni (tərcümələri `i18n`-də).

Yeni miqrasiya əlavə etmək: `src/db.js` → `MIGRATIONS` massivinə yeni SQL sətri. Tətbiq
işə düşəndə özü tətbiq edir (`PRAGMA user_version`).

## 4. API icmalı

Bütün ünvanlar `/api` altındadır. `/api/public/*` istisna olmaqla hamısı giriş tələb edir;
vəziyyəti dəyişən sorğularda `X-CSRF-Token` başlığı məcburidir (dəyəri `GET /api/auth/me` verir).

| Modul | Ünvanlar |
|---|---|
| Giriş | `POST /auth/login`, `/auth/mfa`, `/auth/logout`, `/auth/logout-others`, `/auth/forgot`, `/auth/reset`, `/auth/password`, `/auth/2fa/setup`, `/auth/2fa/enable`, `/auth/2fa/disable`; `GET /auth/me`, `/auth/sessions` |
| Dashboard / analitika | `GET /dashboard`, `/analytics`, `/analytics/sessions`, `/analytics/export` |
| Layihə sorğuları | `GET /leads`, `/leads/export`, `/leads/stats`, `/leads/assignees`, `/leads/:id`, `/leads/:id/files/:fid`; `PATCH /leads/:id`; `POST /leads/:id/notes`, `/leads/:id/email`; `DELETE /leads/:id` |
| Əlaqə sorğuları | `GET /contacts`, `/contacts/export`, `/contacts/:id`; `PATCH /contacts/:id`; `POST /contacts/:id/notes`, `/contacts/:id/email`; `DELETE /contacts/:id` |
| Məzmun | `/news`, `/projects`, `/services`, `/team` — hər biri: `GET` siyahı, `GET /:id`, `POST`, `PUT /:id`, `PATCH /:id`, `DELETE /:id`; `GET /news/export`, `/projects/export`, `/news/meta`, `/projects/meta`; `POST /{projects,services,team}/reorder` |
| Media / sənədlər | `GET/POST /media`, `GET/PUT/DELETE /media/:id`; `GET/POST /documents`, `GET/PUT/PATCH/DELETE /documents/:id`, `GET /documents/:id/download` |
| İstifadəçilər | `GET/POST /users`, `PUT/DELETE /users/:id`, `POST /users/:id/{reset-password,reset-2fa,unlock}`; `GET /roles`, `PUT /roles/:id/permissions` |
| Sistem | `GET /notifications`, `/notifications/summary`; `POST /notifications/read-all`, `/notifications/:id/read`; `GET /audit`, `/audit/export`; `GET /settings`, `/company`, `/system`; `PUT /settings/:group`; `POST /settings/test-email`; `/seo-pages` (CRUD); `GET/POST /backups`, `GET /backups/:id/download`, `DELETE /backups/:id` |
| Saytın xəbər səhifələri | `GET /site/status`; `POST /site/publish` (əl ilə yeniləmə) |
| Açıq (sayt üçün) | `POST /public/form` (saytın 3 forması; köhnə ünvan `POST /contact.php` eyni işi görür), `/public/collect`, `/public/project-request` (fayl əlavəsi ilə), `/public/contact`; `GET /public/news[/:slug]`, `/public/projects[/:slug]`, `/public/services`, `/public/team`, `/public/documents[/:id/download]`, `/public/settings`, `/public/seo` |

Siyahı ünvanlarının ümumi parametrləri: `q` (axtarış — böyük/kiçik hərfə və diakritik
işarələrə həssas deyil: «sirket» → «Şirkət»), `from`, `to` (tarix), status/kateqoriya filtrləri,
`sort` (`-` ilə azalan), `page`, `per_page` (≤ 100). Eksport: `format=xlsx|csv`.

## 5. Rollar

| | Super Admin | Administrator | Editor | Viewer |
|---|---|---|---|---|
| Dashboard, analitika | tam | tam | baxış | baxış |
| Sorğular (layihə, əlaqə) | tam | tam | baxış | baxış |
| Xəbər, layihə, xidmət, komanda, şirkət, sənəd, media | tam | tam | tam | baxış |
| İstifadəçilər | tam | baxış | — | — |
| Tənzimləmələr, SEO | tam | tam | — | — |
| Rolların icazələri, audit jurnalı, ehtiyat nüsxə | **yalnız Super Admin** | — | — | — |

Administrator, Editor və Viewer rollarının icazələrini Super Admin paneldən dəyişə bilər;
son sətirdəki üç icazə heç bir halda başqa rola verilə bilmir. Super Admin hesablarını yalnız
Super Admin yarada, dəyişə və silə bilər; sistemdə ən azı bir aktiv Super Admin qalmalıdır.

## 6. Təhlükəsizlik tədbirləri

| Sahə | Necə həll olunub |
|---|---|
| Şifrələr | scrypt (N=32768, r=8, p=3), hər şifrə üçün ayrıca duz; parametrlər heşin içində saxlanılır. Minimum 12 simvol, 4 sinifdən 3-ü. |
| Sessiya | Təsadüfi 256-bit nişan; bazada yalnız SHA-256 heşi. Kuki: `HttpOnly`, `SameSite=Strict`, `Secure`, `__Host-` prefiksi. Fəaliyyətsizlik (30 dəq) və mütləq (12 saat) müddəti; «Məni xatırla» — 14 gün. Girişdə yeni nişan (session fixation yoxdur). Şifrə/rol dəyişəndə sessiyalar bağlanır. |
| Brute-force | Bir ünvandan bir hesab üçün 5 uğursuz cəhd → 15 dəq blok (hücumçu hesab sahibini bloklaya bilmir); müxtəlif ünvanlardan cəmi 20 uğursuz cəhd → hesabın özü 15 dəq bloklanır; bir ünvandan 15 dəqiqədə ən çox 20 giriş cəhdi. Cavab və cavab müddəti hesabın mövcudluğunu açmır. |
| 2FA | TOTP (RFC 6238), kodun təkrar istifadəsi qadağandır; yanlış kodlar da blok sayğacına düşür. |
| CSRF | Hər sessiya üçün nişan (`X-CSRF-Token`) + `Origin` yoxlaması + `SameSite=Strict`; API yalnız `application/json` qəbul edir. |
| XSS | Panel: bütün HTML avtomatik ekranlaşdıran şablonla qurulur; CSP `script-src 'self'` (sətirdaxili skript işləmir). Sayt üçün verilən mətn: əvvəlcə tam ekranlaşdırılır, yalnız məhdud teqlər əlavə olunur (struktur və təsadüfi testlərlə yoxlanılır). |
| SQL inyeksiyası | Bütün sorğular parametrlidir; sütun adları yalnız kodda olan icazə siyahısından götürülür. |
| Fayllar | Uzantı siyahısı + məzmun (magic bytes) yoxlaması; ölçü limiti; təsadüfi adla saxlanma; SVG-də skript/hadisə/xarici keçid rəddi; fayllar `nosniff` və `sandbox` CSP ilə verilir; sənəd və əlavələr yalnız icazə yoxlanılaraq verilir. |
| Sorğu limitləri | Giriş, bərpa, formalar, sayğac, API — hər biri üçün ayrıca; gövdə ölçüsü oxunmazdan əvvəl və oxunarkən məhdudlaşdırılır; bildiriş məktublarına və anonim fayl qəbuluna ümumi limit. |
| Başlıqlar | `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security` (saytdakı kimi), `Cross-Origin-Opener-Policy`. Panel səhifəsi `Cache-Control: no-store, no-transform` (Cloudflare skript əlavə etməsin). |
| Proxy və IP | Tətbiq standart olaraq yalnız 127.0.0.1-də dinləyir (`HOST`). Canlıda ziyarətçi IP-si Apache-nin `X-Real-IP` başlığından (`TRUST_PROXY=1`) — Apache onu `mod_remoteip` ilə yalnız Cloudflare ünvanlarından gələn `CF-Connecting-IP`-dən götürür; ziyarətçinin göndərdiyi eyni adlı başlıq üzərinə yazılır. Səhv quruluş paneldə və jurnalda göstərilir. |
| Sayt faylları | Generator yalnız `site_files`-dakı faylları dəyişir/silir; panelin yaratmadığı mövcud fayla toxunmur; yazı atomikdir (müvəqqəti fayl + rename), yalnız `xeberler/`, `en/news/`, `ru/news/`, `assets/img/cms/` və `sitemap.xml`. Slug və şəkil yolları regex ilə məhdudlaşdırılıb. |
| Audit | Kritik əməliyyatlar (giriş, yaratma, redaktə, silmə, status, rol, eksport, nüsxə) istifadəçi, modul, qeyd ID, vaxt, IP, əvvəlki/yeni dəyərlə yazılır; baza səviyyəsində dəyişdirilə və silinə bilmir; şifrə və açarlar jurnala düşmür. |
| E-poçt | Başlıqlara sətir keçidi yeridilə bilmir; alıcı ünvanları ciddi yoxlanılır; STARTTLS/TLS məcburidir. |
| Eksport | CSV-də `= + - @` ilə başlayan xanalar zərərsizləşdirilir; Excel-də xanalar düstur deyil, mətn kimi yazılır. |

## 7. Şəxsi məlumatlar

Bu bölmə hüquqi rəy deyil; mətnləri hüquqşünasla razılaşdırın.

- **Toplanan şəxsi məlumat:** formalarda ziyarətçinin özünün yazdığı ad, şirkət, vəzifə,
  e-poçt, telefon, mesaj və əlavə etdiyi fayllar. Hər müraciətdə razılıq qutusu məcburidir;
  razılığın vaxtı bazada saxlanılır.
- **Analitika:** IP ünvanı **saxlanılmır**. Unikal ziyarətçi hər gün dəyişən təsadüfi açarla
  hesablanmış birtərəfli kodla sayılır; açar 2 gündən sonra silinir. Kuki yoxdur. Ölkə
  brauzerin saat qurşağından təxmini müəyyən olunur. Köhnə qeydlər avtomatik silinir
  (standart 400 gün; paneldən dəyişir). «İzləmə» qadağası (DNT/GPC) olan ziyarətçilər sayılmır.
- **Saytın formaları:** sorğular bazada saxlanılır (əvvəllər yalnız e-poçtla gedirdi);
  məxfilik siyasəti buna uyğun yeniləndi (AZ/EN/RU, 14.10.2026).
- **Audit jurnalında IP:** yalnız panel istifadəçilərinin (əməkdaşların) əməliyyatları üçün,
  təhlükəsizlik məqsədilə saxlanılır.
- **Silmə:** müraciətlər paneldən (icazəsi olan istifadəçi tərəfindən) fayl və qeydləri ilə
  birlikdə tam silinə bilir; bu əməliyyat audit jurnalına yazılır.
- **«Fərdi məlumatlar haqqında» Qanun (998-IIIQ):** razılığın forması (maddə 8), məlumatlandırma
  (maddə 11), subyektin hüquqları (maddə 7), fərdi məlumatların informasiya sisteminin dövlət
  qeydiyyatı (maddə 15) və serverin yerləşdiyi ölkə (transsərhəd ötürmə, maddə 14)
  məsələlərini hüquqşünasla dəqiqləşdirin. Məxfilik siyasətində saxlanma müddətini göstərin.

## 8. Sınaq

```bash
npm test
```

- `test/markdown.test.js` — mətn formatının təhlükəsizliyi (məlum hücum nümunələri, 20 000
  təsadüfi kombinasiya, işləmə müddəti).
- `test/api.test.js` — real server üzərində: giriş, CSRF, bloklama, rollar, xəbərlər, fayl
  yükləmə, formalar və e-poçt, analitika, audit, tənzimləmələr, 2FA, şifrə bərpası, nüsxə,
  yanlış məlumatla dayanıqlıq.
- `test/site.test.js` — saytın real surəti ilə: ünvan sxemi və yönləndirmələr, açıq
  yönləndirmə cəhdləri, giriş/çıxış/səhv şifrə/sessiyanın bitməsi, saytın 3 forması və
  köhnə `contact.php` ünvanı, statistika, xəbərlərin idxalı və bayt-bayt eyni generasiyası,
  3 dildə dərc, arxivləşdirmə, panelin yaratmadığı fayla toxunmamaq, XSS.

İşə salma: `npm start` → http://localhost:8080 (sayt) və /admin/ (panel). İlk dəfə Super Admin
üçün müvəqqəti şifrə yaradılır, ekranda və `data/ilk-giris.txt`-də göstərilir. Testlər
layihənin müvəqqəti surətində işləyir, əsl `site/` və `data/`-ya toxunmur.

Bunlardan əlavə hazırlanma zamanı brauzerdə tam ssenari (giriş → hər bölmə → saytdan forma
göndərişi → rol məhdudiyyəti) və iki müstəqil təhlükəsizlik yoxlaması aparılıb; tapılan
problemlər düzəldilib və testlərə əlavə olunub.

**Sınanmayanlar:** real Apache və Cloudflare (onların rolunu HTTPS sınaq proxy-si oynayıb),
real SMTP serveri ilə STARTTLS, systemd xidməti, yüksək yük.

## 9. Məhdudiyyətlər və gələcək işlər

- `node:sqlite` modulu Node 22-də «eksperimental» işarəlidir (işləkdir). Node-un böyük versiyasını dəyişməzdən əvvəl testləri işə salın.
- Tətbiq bir proses kimi işləyir; sorğu limitləri yaddaşdadır (yenidən başladılanda sıfırlanır).
- Şəkillər avtomatik kiçildilmir — yükləməzdən əvvəl ölçüsünü azaltmaq tövsiyə olunur.
- Ölkə Cloudflare-in `CF-IPCountry` başlığından (`GEO_COUNTRY_HEADER=cf-ipcountry`); şəhər
  yalnız proxy bunu başlıqla verəndə (`GEO_CITY_HEADER`).
- Mətn redaktoru sadələşdirilmiş formatdır (başlıq, qalın, kursiv, siyahı, sitat, keçid, şəkil).
- Saytın Layihələr, Həllər, Haqqımızda, Əlaqə səhifələri hələ statik HTML-dir; paneldəki
  uyğun bölmələrin məlumatı (`/api/public/*`-da mövcuddur) bu səhifələrə avtomatik düşmür.
  Növbəti addım xəbərlərdəki kimi şablon əsaslı generasiyadır.
- Gələcək inteqrasiyalar üçün hazır yerlər: tənzimləmələrdə Google Analytics / Search Console /
  CRM webhook / Telegram / WhatsApp sahələri; yeni müraciət hadisəsi `src/notify.js`-də bir
  yerdə toplanıb — CRM və ya messencer bildirişi oraya əlavə olunur.
