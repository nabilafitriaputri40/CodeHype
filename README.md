# Portable SEO Mirror

Reverse proxy Node.js 24 untuk Railway, Render, dan VPS. Sumber bawaan: `https://www.codehype.ai`. Tidak membutuhkan Cloudflare Workers, database, atau proses build frontend.

## Mulai paling cepat: GitHub → Railway

1. Ekstrak ZIP. Upload **isi folder `mirror-portable`** ke root repository GitHub: `package.json`, `Dockerfile`, `src`, `config`, dan file lainnya. Sertakan `package-lock.json`. Jangan upload `node_modules` atau `.env`.
2. Railway → New Project → Deploy from GitHub Repo → pilih repository. Dockerfile akan dipakai.
3. Buat domain Railway atau pasang custom domain Anda pada service tersebut.
4. Pada Variables, isi:

   ```dotenv
   NODE_ENV=production
   UPSTREAM_ORIGIN=https://www.codehype.ai
   UPSTREAM_ALIASES=https://codehype.ai,http://www.codehype.ai,http://codehype.ai
   PUBLIC_ORIGIN=https://domain-anda.com
   ENABLE_INDEXING=true
   TRUST_PROXY=true
   ```

5. Ganti `domain-anda.com` dengan domain yang benar-benar terpasang di service. Tanpa slash/path. Jangan isi domain sumber. Railway memasok `PORT`; aplikasi bind ke `0.0.0.0`.
6. Service Settings → Healthcheck Path: `/healthz`. Biarkan Dockerfile menjalankan start command.
7. Deploy/redeploy. Buka `/`, `/robots.txt`, `/sitemap.xml`, dan satu halaman detail. Semua domain alternatif diarahkan 308 ke `PUBLIC_ORIGIN`, termasuk domain Railway apabila custom domain dipilih.
8. Verifikasi domain milik Anda di Search Console, submit `https://domain-anda.com/sitemap.xml`, lalu jalankan audit di bawah.

Jika hanya memakai domain Railway, set `PUBLIC_ORIGIN` ke URL HTTPS domain Railway itu. Variabel `RAILWAY_PUBLIC_DOMAIN` atau `RENDER_EXTERNAL_URL` dapat menjadi fallback otomatis, tetapi `PUBLIC_ORIGIN` eksplisit disarankan agar custom domain selalu konsisten. Canonical tidak diambil dari header Host pengunjung.

Tidak ada `railway.json`: paket memakai Dockerfile dan pengaturan service agar tidak bergantung pada format Railway Config as Code lama. Tidak ada biaya deployment yang diaktifkan oleh paket; pilih resource/plan pada provider Anda sendiri.

## Render

- Buat Web Service dari GitHub, pilih Docker; atau gunakan Blueprint `render.yaml` yang sudah tersedia.
- Isi `PUBLIC_ORIGIN=https://domain-anda.com` saat diminta. Tambahkan domain itu pada service.
- Healthcheck: `/healthz`. Render memasok `PORT`.
- Alternatif runtime native: Node 24, build `npm ci --omit=dev`, start `npm start`, dengan variabel yang sama.

## VPS dengan Docker dan HTTPS

```bash
cp .env.example .env
# Edit .env: terutama PUBLIC_ORIGIN dan UPSTREAM_ORIGIN.
docker compose up -d --build
```

Container listen di port 3000; Compose hanya mempublikasikannya pada `127.0.0.1:3000`. Letakkan Caddy/NGINX di depannya untuk HTTPS. Contoh Caddy ada di `deploy/Caddyfile.example`; ganti domain dan arahkan DNS ke VPS. Caddy meneruskan host/protocol yang dibutuhkan. Batasi akses port backend ke reverse proxy tepercaya ketika `TRUST_PROXY=true`.

Tanpa Docker: instal Node.js 24, jalankan `npm ci --omit=dev`, isi `.env`, lalu `npm start`. Contoh service systemd ada di `deploy/mirror.service.example`; sesuaikan user, lokasi repo, dan lokasi binary Node. Gunakan `HOST=127.0.0.1` pada VPS jika proses hanya diakses melalui proxy lokal. `TRUST_PROXY=false` digunakan untuk HTTP lokal tanpa reverse proxy.

## Yang diperbaiki

| Bagian | Perilaku |
| --- | --- |
| Canonical | Satu canonical absolut untuk halaman publik HTTP 200; HTTP Link dan `og:url` konsisten. Alias canonical dari sumber dihormati bila berasal dari origin yang diizinkan. Canonical sumber yang keliru menunjuk beranda dari halaman detail diabaikan. |
| Parameter URL | `utm_*`, `gclid`, `fbclid`, dan tracking umum dibuang dari canonical dan sitemap. Parameter isi seperti `page`, pencarian, dan filter dipertahankan. Tracking tidak dipaksa redirect agar alur aplikasi tidak rusak. |
| Host/protokol | Domain alternatif dan HTTP diarahkan 308 ke origin publik HTTPS yang Anda tetapkan. Healthcheck dikecualikan agar deployment tidak macet. |
| Sitemap | `/sitemap.xml`, index, child maps, dan `.xml.gz`; discovery dari robots; URL absolut diganti; namespace image/video/hreflang dan lastmod dipertahankan; URL asing, duplikat, dan prefix noindex disaring; probe bertahap memperbaiki alias canonical, 404/410, dan noindex sumber. |
| Sumber punya root sitemap lain | `/sitemap.xml` menghasilkan index yang merujuk sitemap yang dideklarasikan sumber, apabila `/sitemap.xml` asli 404. Tidak membuat sitemap kosong seolah berhasil jika sumber tidak menyediakan sitemap. |
| Robots | Aturan sumber dipertahankan, deklarasi sitemap memakai domain Anda, termasuk root khusus yang ditemukan. CSS/JS tidak diblokir secara massal. |
| Data terstruktur | JSON-LD diparse tanpa eval, URL origin direwrite, BreadcrumbList valid dinormalisasi posisi/nama/item. JSON-LD tak dapat diparse atau breadcrumb tanpa data cukup dihapus dan dicatat pada log. |
| Breadcrumb lama | Microdata BreadcrumbList diubah menjadi JSON-LD berdasarkan label/link navigasi yang terlihat bila cukup. Tidak mengarang hierarki dari slug URL. |
| Next.js | Aset `/_next`, request RSC, query `_rsc`, dan router headers dipertahankan. Flight JSON/text rows dan panjang UTF-8 text rows ditangani; binary rows tidak diubah. Payload tak dikenali dibiarkan utuh dengan log `flight_rewrite_skipped`. |
| HTML/CSS/JS/JSON | URL origin sumber diubah secara terbatas pada origin yang diizinkan, termasuk escaped URL dalam script. Link ke pihak ketiga tetap seperti sumber. |
| 404/410/5xx | Status sumber dipertahankan. Halaman gagal tidak diubah menjadi beranda/HTTP 200. Timeout menghasilkan 504; kegagalan proxy 502. Error diberi noindex. |
| Cache | Cache memori dibatasi ukuran; session/cookie/auth/RSC tidak memakai cache bersama. No-store/private sumber dihormati. HTML hasil transform tidak di-cache oleh CDN/browser; byte aset biner tetap streaming. |
| Verifikasi Search Console | Mendukung meta verification dan file HTML melalui konfigurasi. Token verifikasi milik situs sumber dihapus. |

## Sitemap: pengaturan dan audit

Sitemap tidak hanya di-hardcode pada satu file. Aplikasi membaca robots sumber, mengikuti lokasi index yang diakses, mendaftarkan child maps, dan merewrite setiap peta saat diminta. Child XML pada lokasi umum juga dikenali dari root XML, sehingga URL dalam map tetap berfungsi setelah restart. Untuk lokasi khusus atau sitemap yang tidak tercantum pada robots, set misalnya:

```dotenv
SITEMAP_PATHS=/sitemap.xml,/sitemap_index.xml,/maps/root.xml
```

`UPSTREAM_ALIASES` harus mencakup origin lain yang digunakan sumber di sitemap, misalnya versi tanpa www. Origin pihak ketiga tidak diproxy atau dicrawl sebagai sitemap. Sitemap lebih dari 50.000 entri harus dibagi di sumber. Batas teks default 16 MiB berlaku pada file yang perlu diubah; jika sitemap valid Anda lebih besar, naikkan `MAX_TEXT_BYTES` sampai maksimal 100 MiB. Jangan mengisi `lastmod` palsu setiap request.

Sitemap juga memiliki validasi bertahap: default maksimal 30 URL yang belum diperiksa per file per refresh, empat request paralel, dengan anggaran waktu 8 detik. Hasil validasi disimpan 1 jam. Halaman 404/410/noindex dikeluarkan dan alias canonical dipetakan ke URL pilihan sumber yang valid. Contoh yang ditemukan saat pengembangan: `/launches` memilih canonical minggu berjalan; sitemap mirror memakai URL minggu tersebut setelah probe. Sisa URL tetap mengikuti sumber dan akan diperiksa pada refresh berikutnya; ini bukan jaminan seluruh sitemap langsung tervalidasi. Kegagalan sementara/timeout tidak dianggap 404. Log `sitemap_validated` melaporkan checked/remaining. Ubah `SITEMAP_VALIDATE_LIMIT`, `SITEMAP_VALIDATION_BUDGET_MS`, `SITEMAP_VALIDATION_CONCURRENCY`, dan `SITEMAP_PROBE_TTL_SECONDS` sesuai kapasitas sumber. Set limit 0 untuk menonaktifkan probe.

Untuk memastikan semua URL, jalankan audit dengan limit cukup besar; perbaiki URL yang masih bermasalah di sumber atau keluarkan lewat prefix noindex. Jangan menambahkan redirect massal semua halaman hilang ke `/`. Pada sitemap pertama sesudah cache kosong, anggaran probe menambah latency maksimal sesuai setting; map gagal tetap mengembalikan status error yang benar.

```bash
npm ci
npm test
npm run audit:source
npm run audit:seo -- https://domain-anda.com --limit 30
# Audit seluruh daftar dengan limit yang cukup besar, berjalan berurutan:
npm run audit:seo -- https://domain-anda.com --limit 10000 --maps 100 --output audit.json
```

Audit memeriksa robots, sitemap secara rekursif, status HTTP halaman, konflik canonical, noindex, dan JSON-LD/Breadcrumb dasar. Hasil mencantumkan jumlah total/yang diperiksa dan peringatan bila terkena limit. Exit code 1 berarti ditemukan masalah. Ini bukan validasi kelayakan rich results Google dan tidak menjalankan browser. Uji halaman detail di [Rich Results Test](https://search.google.com/test/rich-results) serta URL Inspection → Test Live URL → rendered HTML. Periksa bahwa JavaScript tidak mengembalikan canonical ke domain sumber sesudah hidrasi.

Setelah menambahkan domain baru, pastikan `PUBLIC_ORIGIN` sudah diganti lalu redeploy; sitemap cache disimpan dalam memori dan dibersihkan saat restart. Jangan sekaligus menyubmit versi HTTP, www/non-www, domain provider, dan domain final sebagai URL berbeda.

## Konten asli dan batas canonical

`CANONICAL_MODE=mirror` adalah default sesuai permintaan: canonical memakai domain Anda. Ini sinyal preferensi, bukan perintah yang wajib diikuti Google. Konten yang identik di dua domain masih dapat dikelompokkan sebagai duplikat, dan Google dapat memilih situs sumber. Sitemap membantu discovery, bukan jaminan indexing. Mengganti canonical, judul, nama merek, atau beberapa kata saja tidak membuat salinan menjadi konten unik.

Untuk peluang indeks mandiri, tambahkan nilai yang nyata: ulasan hasil uji, perbandingan, data asli, panduan berbahasa Indonesia, atau kurasi editorial yang berguna. `config/pages.json` mendukung per-path:

```json
{
  "/products/nama-produk": {
    "renderMode": "static",
    "title": "Judul ulasan asli Anda",
    "description": "Deskripsi yang sesuai isi ulasan",
    "heading": "Hasil pengujian",
    "intro": "Tulis temuan asli Anda di sini.",
    "paragraphs": ["Penjelasan tambahan berdasarkan fakta yang telah diuji."]
  }
}
```

Contoh lengkap tersedia pada `config/pages.example.json`; file aktif tetap `{}` agar contoh tidak terbit tanpa sengaja. Konten ini ditampilkan kepada semua pengunjung dan crawler. Untuk halaman Next.js yang diberi override, default-nya **HTML statis per halaman**: script aplikasi di halaman itu dihapus supaya React tidak membuang konten tambahan atau mengembalikan metadata lama ketika hidrasi. Tampilan/CSS dan link biasa tetap ada, tetapi menu/dropdown/pencarian client-side di halaman override dapat tidak aktif; halaman tanpa override tetap memakai script sumber. `renderMode: "interactive"` mempertahankan script hanya jika Anda sudah mengintegrasikan override dengan aplikasi sumber dan menguji hidrasi sendiri. Tidak ada bot cloaking atau klaim anti-duplikat otomatis. Optional `h1` mengganti H1 pertama; gunakan hanya bila sesuai isi halaman. Konten dinamis sumber dapat berubah, sehingga review editorial Anda juga perlu diperbarui.

Jika tujuan Anda menyediakan mirror sambil mengonsolidasikan pencarian ke sumber, gunakan `CANONICAL_MODE=upstream`; sitemap halaman juga akan menunjuk sumber. Mode tersebut tidak ditujukan agar mirror mendapat indeks mandiri. Untuk migrasi domain milik Anda, redirect 301 dari domain lama ke baru adalah sinyal tambahan yang harus dikonfigurasi pada domain lama; proxy ini tidak dapat mengubah situs sumber dari luar.

## Search Console: arti laporan dan langkah sesudah deploy

- **Duplikat, Google memilih kanonis berbeda:** periksa rendered canonical dan sitemap konsisten; untuk isi identik, pilihan Google tetap mungkin jatuh ke sumber.
- **Tidak ditemukan (404):** perbaiki link/URL yang salah atau keluarkan URL yang benar-benar sudah hilang. Pakai redirect spesifik hanya bila ada pengganti yang setara.
- **Halaman dengan pengalihan:** URL lama/domain alternatif memang tidak perlu diindeks. Submit URL akhir HTTP 200 dalam sitemap. Laporan ini bukan otomatis bug.
- **Breadcrumb / data terstruktur tidak dapat diurai:** lihat log `schema_cleaned`, uji rich results pada URL hasil mirror. Penghapusan markup rusak menghentikan publikasi markup itu; bukan bukti semua tipe schema layak rich result.

1. Pasang domain dan HTTPS, isi origin final.
2. Verifikasi milik Anda dengan DNS TXT (paling mudah) atau `GOOGLE_SITE_VERIFICATION`.
3. Untuk metode file, isi `config/verification-files.json` mengikuti `config/verification-files.example.json` dengan nama/isi persis dari Google.
4. Submit `/sitemap.xml`, inspeksi homepage dan beberapa halaman detail.
5. Setelah perbaikan terbit, lakukan Validate Fix pada isu terkait. Crawling ulang dan pemilihan canonical perlu waktu; tidak ada jaminan tanggal atau jumlah URL terindeks.

## Batas mirror aplikasi

Paket ini reverse proxy, bukan salinan source code/database atau ekspor offline. Konten dan aset tetap memerlukan sumber aktif. Gunakan untuk situs yang Anda miliki atau mempunyai izin untuk dipublikasikan ulang; pertahankan atribusi dan informasi hak cipta.

Default hanya GET/HEAD untuk mirror publik, tanpa meneruskan cookie/Authorization atau menerima login/pembayaran. Jika Anda mengelola backend sumber dan memerlukan operasi aplikasi, atur `ALLOW_WRITE_METHODS=true` dan `PROXY_COOKIES=true`, lalu konfigurasi domain callback OAuth, allowed origins, domain session, webhook/payment return URL, dan link email di backend asli. `Set-Cookie` yang diaktifkan dibuat host-only pada mirror; ini tidak memindahkan sesi login domain sumber. Jangan menganggap OAuth/payment lintas domain otomatis berfungsi.

WebSocket, service worker scope khusus, API pihak ketiga, anti-bot challenge, asset host tambahan, dan aplikasi yang menghitung domain pada runtime bisa memerlukan integrasi tersendiri. Tidak ada bypass CAPTCHA/paywall/anti-bot. Subdomain gambar seperti `images.codehype.ai` tetap memakai host gambar aslinya kecuali Anda menambahkan integrasi sendiri; `UPSTREAM_ALIASES` hanya untuk origin yang menyajikan **rute situs yang sama**, bukan CDN berbeda.

CSP sumber dihilangkan secara default karena hash dan origin script dapat tidak cocok setelah rewrite; header anti-sniffing dan referrer policy tetap dipasang. Untuk produksi yang membutuhkan CSP, susun policy sesuai aset pada mirror setelah pengujian. `KEEP_UPSTREAM_CSP=true` hanya mempertahankan policy asli, tidak menghitung ulang hash. ETag hasil teks dihitung ulang. Range request biner dipertahankan; jangan gunakan transform proxy untuk unduhan teks parsial yang membutuhkan byte offset asli.

## Konfigurasi tambahan

Lihat `.env.example`. Konfigurasi dibaca saat startup, jadi perubahan membutuhkan restart/redeploy. `config/redirects.json` memuat redirect path spesifik; jangan membuat loop/rantai. `NOINDEX_PATH_PREFIXES` dipakai untuk halaman dan sitemap, bukan aturan penghapusan seluruh situs. Tidak ada akses edit konfigurasi melalui endpoint publik.

Log request memuat method/path/status/durasi/request id; query, cookie, dan body tidak dicatat. Cache/discovery bersifat per-instance dan hilang setelah restart, sehingga replika tidak memerlukan volume bersama.

## Referensi

- [Google: canonical dan duplikat](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [Google: pembuatan sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google: BreadcrumbList](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb)
- [Railway: Dockerfile](https://docs.railway.com/guides/dockerfiles)
- [Railway: healthcheck](https://docs.railway.com/deployments/healthchecks)
- [Render: Blueprint](https://render.com/docs/blueprint-spec)
