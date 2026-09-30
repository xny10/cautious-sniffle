import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from app import app
from core.resolver import ParseError, normalize_rows, extract_ids_from_url

class APITest(unittest.TestCase):
    def setUp(self): self.client=TestClient(app)
    def test_assets_health(self):
        for url in ['/', '/static/app.js','/static/engine.js','/static/style.css','/api/health']:
            self.assertEqual(self.client.get(url).status_code,200)
        self.assertEqual(self.client.get('/api/health').json()['storage'],'browser-indexeddb')
    def test_csv(self):
        rows=normalize_rows('Destination URL,Link Iklan Aktif\nhttps://s.shopee.co.id/a,https://facebook.com/1\nhttps://s.shopee.co.id/a,\n')
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['adLibraryUrl'],'https://facebook.com/1')
    def test_ids(self):
        self.assertEqual(extract_ids_from_url('https://shopee.co.id/product/123/456'),('123','456'))
    def test_mixed_batch(self):
        with patch('app.resolve_shortlink',side_effect=[{'shopId':'123','productId':'456'},ParseError('HTTP 429','RATE_LIMIT')]):
            response=self.client.post('/api/shopee/batch',json={'items':[{'id':'a','shortUrl':'https://s.shopee.co.id/a'},{'id':'b','shortUrl':'https://s.shopee.co.id/b'}]})
        self.assertEqual(response.status_code,200)
        results=response.json()['results'];self.assertTrue(results[0]['ok']);self.assertEqual(results[1]['code'],'RATE_LIMIT')
    def test_validation(self):
        self.assertEqual(self.client.post('/api/shopee/batch',json={'items':[]}).status_code,422)
        self.assertEqual(self.client.post('/api/shopee/brand',json={'shopId':'../../foo'}).status_code,422)
        result=self.client.post('/api/shopee/batch',json={'items':[{'id':'x','shortUrl':'http://localhost/'}]}).json()
        self.assertEqual(result['results'][0]['code'],'INVALID_SHORTLINK')

if __name__=='__main__':unittest.main()
