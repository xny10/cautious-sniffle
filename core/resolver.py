from __future__ import annotations
import csv
import io
import re
import time
from urllib.parse import unquote, urlparse, urljoin
import requests


class ParseError(Exception):
    def __init__(self, message, code="ERROR"):
        super().__init__(message); self.code = code


def now_ms(): return int(time.time()*1000)

def short_error(s):
    return re.sub(r"https?://\S+", "", str(s or "")).strip()[:180]


def normalize_rows(raw):
    if isinstance(raw, list):
        entries = raw
    else:
        text = str(raw or "")
        entries = []
        lines = [x for x in text.splitlines() if x.strip()]
        if lines and "," in lines[0]:
            try:
                rows = list(csv.reader(io.StringIO(text)))
                header = [h.lower().lstrip("\ufeff").strip() for h in rows[0]]
                has_header = any("destination" in h for h in header) or any("link iklan" in h for h in header)
                dest_idx = next((i for i,h in enumerate(header) if "destination" in h), 0)
                active_idx = next((i for i,h in enumerate(header) if "link iklan" in h or "adlibrary" in h or "ad library" in h), 1)
                for row in rows[1:] if has_header else rows:
                    short = row[dest_idx].strip() if len(row)>dest_idx else ""
                    active = row[active_idx].strip() if len(row)>active_idx else ""
                    entries.append({"shortUrl": short, "adLibraryUrl": active})
            except Exception:
                entries = lines
        else:
            entries = lines
    seen = {}
    for entry in entries:
        if isinstance(entry, dict):
            val = str(entry.get("shortUrl") or entry.get("destinationUrl") or "")
            active = str(entry.get("adLibraryUrl") or entry.get("activeAdLink") or "")
        else:
            val, active = str(entry), ""
        m = re.search(r"https?://s\.shopee\.co\.id/[^\s,\"'|]+", val, re.I)
        if not m: continue
        short = re.sub(r"[),.;]+$", "", m.group(0).strip())
        key = short.lower()
        seen[key] = {"shortUrl": short, "adLibraryUrl": active or seen.get(key,{}).get("adLibraryUrl","")}
    return list(seen.values())


def safe_decode(value):
    out = str(value or "")
    for _ in range(3):
        try:
            d = unquote(out)
            if d == out: break
            out = d
        except Exception: break
    return out


def extract_ids_from_url(value):
    decoded = safe_decode(value).replace("\\u002F", "/").replace("\\/", "/")
    patterns = [
        (re.compile(r"/product/(\d+)/(\d+)", re.I), False),
        (re.compile(r"/[^/?#]+/(\d{6,})/(\d{6,})(?:[/?#]|$)", re.I), False),
        (re.compile(r"(?:^|[?&#])shopid=(\d+).*?(?:[?&#])itemid=(\d+)", re.I), False),
        (re.compile(r"(?:^|[?&#])shop_id=(\d+).*?(?:[?&#])item_id=(\d+)", re.I), False),
        (re.compile(r"(?:^|[?&#])itemid=(\d+).*?(?:[?&#])shopid=(\d+)", re.I), True),
        (re.compile(r"(?:^|[?&#])item_id=(\d+).*?(?:[?&#])shop_id=(\d+)", re.I), True),
        (re.compile(r"(?:-|%2D)i\.(\d+)\.(\d+)", re.I), False),
        (re.compile(r"/i\.(\d+)\.(\d+)", re.I), False),
        (re.compile(r"shop(?:id|_id)[\"'=: ]+(\d+).*?item(?:id|_id)[\"'=: ]+(\d+)", re.I|re.S), False),
        (re.compile(r"item(?:id|_id)[\"'=: ]+(\d+).*?shop(?:id|_id)[\"'=: ]+(\d+)", re.I|re.S), True),
    ]
    for pat, rev in patterns:
        m = pat.search(decoded)
        if m:
            return (m.group(2), m.group(1)) if rev else (m.group(1), m.group(2))
    return "", ""


def resolve_shortlink(short_url, timeout_ms=15000):
    if not re.match(r"^https?://s\.shopee\.co\.id/", short_url, re.I):
        raise ParseError("Shortlink bukan domain s.shopee.co.id", "INVALID_SHORTLINK")
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    deadline = time.monotonic() + 35
    full, body = short_url, ""
    try:
        with requests.Session() as session:
            for hop in range(6):
                parsed = urlparse(full)
                host = (parsed.hostname or "").lower()
                if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or parsed.port not in (None, 80, 443) or not (host == "shopee.co.id" or host.endswith(".shopee.co.id")):
                    raise ParseError("Redirect bukan domain Shopee Indonesia", "INVALID_SHORTLINK")
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise ParseError("Request timeout", "TIMEOUT")
                with session.get(full, allow_redirects=False, stream=True,
                                 timeout=min(timeout_ms / 1000, remaining), headers=headers) as r:
                    if r.status_code == 429: raise ParseError("HTTP 429 Too Many Requests", "RATE_LIMIT")
                    if r.status_code >= 400: raise ParseError(f"HTTP {r.status_code}", "NETWORK")
                    if r.is_redirect:
                        full = urljoin(full, r.headers.get("Location", ""))
                        shop, prod = extract_ids_from_url(full)
                        if shop and prod:
                            return {"fullUrl": full, "productUrl": full, "shopId": shop, "productId": prod}
                        if hop == 5: raise ParseError("Terlalu banyak redirect", "NETWORK")
                        continue
                    chunks, size = [], 0
                    if any(t in r.headers.get("content-type", "") for t in ("text", "html")):
                        for chunk in r.iter_content(16384):
                            if time.monotonic() > deadline: raise ParseError("Request timeout", "TIMEOUT")
                            chunks.append(chunk); size += len(chunk)
                            if size >= 2_000_000: break
                    body = b"".join(chunks).decode(r.encoding or "utf-8", errors="replace")
                    break
    except requests.Timeout:
        raise ParseError("Request timeout", "TIMEOUT")
    except requests.RequestException:
        raise ParseError("Request jaringan gagal", "NETWORK")
    candidates = {full}
    for v in [full, safe_decode(full)]: candidates.add(v)
    try:
        parsed = urlparse(full)
        for part in parsed.query.split("&"):
            if "=" in part:
                candidates.add(safe_decode(part.split("=",1)[1]))
    except Exception: pass
    for raw in re.findall(r"https?:\\?/\\?/[^\s\"'<>]+", body, re.I):
        candidates.add(safe_decode(raw.replace("\\/", "/")))
    for cand in candidates:
        shop, prod = extract_ids_from_url(cand)
        if shop and prod:
            return {"fullUrl": full, "productUrl": cand, "shopId": shop, "productId": prod}
    # limited body scan fallback
    shop, prod = extract_ids_from_url(body[:2_000_000])
    if shop and prod:
        return {"fullUrl": full, "productUrl": full, "shopId": shop, "productId": prod}
    raise ParseError(f"URL akhir bukan halaman produk Shopee. Final URL: {full}", "NOT_PRODUCT")

