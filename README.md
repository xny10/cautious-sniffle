# Shopee Bulk Extractor — Vercel

Migrasi dari Railway: FastAPI stateless + antrean browser + IndexedDB. Tidak membutuhkan Railway, Docker, SQLite, atau database berbayar.

## Deploy dari GitHub

1. Ganti isi repo dengan isi versi ini, lalu commit/push ke GitHub.
2. Vercel → Add New → Project → import repository.
3. Framework Preset: **FastAPI**. Root Directory: root repo.
4. Biarkan Build Command, Output Directory, dan Install Command memakai default framework. Hapus override Railway/Node dari project lama bila ada.
5. Deploy. Buka `/api/health` untuk mengecek API, lalu `/` untuk aplikasi.

`app.py` adalah entrypoint; `vercel.json` menetapkan batas request 60 detik. Tidak perlu environment variable. Python 3.12 ditetapkan di `.python-version`.

## Cara kerja dan batasan

- Browser mengirim paling banyak 10 shortlink per request. Retry dan cooldown dijadwalkan di browser, tidak ada thread yang diandalkan setelah respons selesai.
- **Biarkan tab terbuka dan perangkat aktif selama proses.** Tab background dapat diperlambat browser. Menutup tab menghentikan penjadwalan; refresh membuka sesi dalam keadaan pause. Klik **Lanjutkan** untuk meneruskan.
- Job aktif dan maksimal 50 card sesi disimpan dalam **IndexedDB browser yang sama dan domain yang sama**, bukan server. Data tidak otomatis muncul di perangkat/domain lain. Menghapus data situs atau mode privat dapat menghilangkannya. Gunakan Download Session untuk backup.
- Hanya satu tab aplikasi di domain yang sama boleh aktif agar data tidak saling menimpa.
- Pause membiarkan batch aktif selesai dan menyimpan hasilnya. Stop membatalkan antrean dan mengabaikan respons batch yang datang terlambat.
- Retry gagal, dedupe, copy ID/offer, import TXT/CSV, export CSV, serta import/export session JSON tetap tersedia.
- Kategori Brand Offer diambil satu toko per request. Cookie hanya dikirim untuk request terkait, tidak disimpan. Endpoint Shopee dapat berubah atau menolak akses.
- IP datacenter Vercel tetap dapat dibatasi Shopee. HTTP 429 dijadwalkan ulang dengan cooldown 30–90 detik. Keberhasilan resolve live tidak dijamin oleh konfigurasi deployment.
- Statistik jumlah iklan menghitung baris input yang memiliki link iklan; bukan pengecekan status iklan secara live.
- API lama yang menyimpan job di server diganti API stateless; UI versi lama harus ikut diganti.

## Memindahkan data Railway

Sebelum pindah, Download Session di versi Railway. Setelah versi Vercel aktif, pilih Load Session dan klik Lanjutkan bila masih ada antrean. Card yang lain perlu diekspor satu per satu. SQLite lama tidak dipindahkan otomatis.

## Lokal

```bash
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Buka http://localhost:8000. Web Locks dan IndexedDB memerlukan browser modern; gunakan HTTPS untuk deployment.

## Verifikasi

```bash
pip install httpx
python -m unittest discover -s tests
node tests/engine.test.cjs
```

Pengujian memakai respons Shopee tiruan untuk parser, API batch, recovery, retry, pause, stop, dan persistensi. Deployment Vercel serta akses Shopee live perlu diverifikasi setelah import project.
