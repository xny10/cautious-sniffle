"""Stateless Vercel API. Jobs and retry scheduling live in the browser."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import os
import requests
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from core.resolver import normalize_rows, resolve_shortlink, ParseError, short_error

BASE = Path(__file__).resolve().parent
app = FastAPI(title="Shopee Bulk Vercel", version="3.0.0")
app.mount('/static', StaticFiles(directory=BASE / 'static'), name='static')

class StartBody(BaseModel):
    links: str | list = Field(max_length=2_000_000)

class Item(BaseModel):
    id: str = Field(max_length=100)
    shortUrl: str = Field(max_length=2048)

class BatchBody(BaseModel):
    items: list[Item] = Field(min_length=1, max_length=10)

class BrandBody(BaseModel):
    shopId: str = Field(pattern=r'^\d{1,30}$')
    cookie: str = Field(default='', max_length=16000)

@app.get('/', response_class=HTMLResponse)
def index():
    return (BASE / 'static/index.html').read_text()

@app.get('/api/health')
def health():
    return {'ok': True, 'service': 'shopee-bulk', 'storage': 'browser-indexeddb', 'mode': 'request-batch'}

@app.post('/api/shopee/normalize')
def normalize(body: StartBody):
    return {'rows': normalize_rows(body.links)}

@app.post('/api/shopee/batch')
def batch(body: BatchBody):
    def process(item):
        try:
            return {'id': item.id, 'ok': True, **resolve_shortlink(item.shortUrl, 5000)}
        except ParseError as exc:
            return {'id': item.id, 'ok': False, 'code': exc.code, 'error': short_error(exc)}
        except Exception:
            return {'id': item.id, 'ok': False, 'code': 'NETWORK', 'error': 'Gagal memproses request'}
    with ThreadPoolExecutor(max_workers=len(body.items)) as pool:
        return {'results': list(pool.map(process, body.items))}

@app.post('/api/shopee/brand')
def brand(body: BrandBody):
    headers = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'}
    if body.cookie:
        headers['Cookie'] = body.cookie
    try:
        response = requests.get('https://affiliate.shopee.co.id/api/v3/offer/shop',
            params={'shop_id': body.shopId}, headers=headers, timeout=10, allow_redirects=False)
        if response.status_code != 200:
            return {'brandOfferError': f'HTTP {response.status_code}; periksa akses Affiliate Shopee'}
        data = response.json().get('data') or {}
        if not isinstance(data, dict):
            return {'brandOfferError': 'Format respons Affiliate tidak dikenal'}
        return {'shopName': data.get('shop_name', data.get('shopName', data.get('name', ''))),
                'brandCategory': data.get('category_name', data.get('categoryName', data.get('primary_category_name', ''))),
                'commissionRate': data.get('commission_rate', data.get('commissionRate', '')),
                'offerStatus': data.get('status', data.get('offer_status', '')),
                'offerId': data.get('offer_id', ''), 'brandOfferError': ''}
    except (requests.RequestException, ValueError):
        return {'brandOfferError': 'Gagal mengambil kategori; coba kembali'}

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('app:app', host='0.0.0.0', port=int(os.getenv('PORT', '8000')))
