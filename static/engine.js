/* Durable browser-owned jobs; the server only resolves one small batch per request. */
const engine = (() => {
  let job = null, sessions = [], revision = 0, running = false, busyBrand = false;
  const clone = value => structuredClone(value);
  const dbReady = new Promise((resolve, reject) => {
    const request = indexedDB.open('shopee-bulk-vercel', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Penyimpanan browser tidak tersedia'));
  });
  async function storage(mode, value) {
    const db = await dbReady;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', mode);
      const store = tx.objectStore('state');
      const request = mode === 'readonly' ? store.get('workspace') : store.put(value, 'workspace');
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error('Gagal menyimpan sesi. Download Session sebelum menutup tab.'));
    });
  }
  const ready = storage('readonly').then(data => {
    job = data?.job || null; sessions = data?.sessions || [];
    recover(job);
  });
  function recover(target) {
    if (!target) return;
    if (['processing', 'waiting'].includes(target.status)) target.status = 'paused';
    target.waitingUntil = null;
    target.items.forEach(item => { if (['processing','retrying'].includes(item.status)) item.status = 'queued'; });
  }
  function summarize() {
    if (!job) return;
    job.total = job.items.length;
    for (const [key, status] of [['success','success'],['failed','failed'],['cancelled','cancelled']]) {
      job[key] = job.items.filter(i => i.status === status).length;
    }
    job.processed = job.success + job.failed + job.cancelled;
    job.updatedAt = Date.now();
  }
  async function persist() { summarize(); await storage('readwrite', clone({job, sessions})); }
  async function remote(path, body) {
    const response = await fetch('/api/shopee/' + path, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body),
      signal: AbortSignal.timeout(65000)
    });
    if (!response.ok) throw new Error(`Request gagal (HTTP ${response.status}). Coba Lanjutkan.`);
    return response.json();
  }
  function config(raw = {}) {
    const bounded = (v, fallback, lo, hi) => Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : fallback;
    return {concurrency: Math.floor(bounded(raw.concurrency,5,1,10)), maxRetries: Math.floor(bounded(raw.maxRetries,2,0,5)),
      batchDelayMin: bounded(raw.batchDelayMin,2000,0,120000), batchDelayMax: bounded(raw.batchDelayMax,6000,0,120000)};
  }
  function delay(lo, hi) { return lo + Math.random() * Math.max(0, hi-lo); }
  function idleRequired() {
    if (running || busyBrand || ['processing','waiting'].includes(job?.status)) throw new Error('Pause dulu dan tunggu batch aktif selesai.');
  }
  async function tick() {
    await ready;
    if (running || !job || !['processing','waiting'].includes(job.status)) return;
    if ((job.waitingUntil || 0) > Date.now()) return;
    const queued = job.items.filter(i => i.status === 'queued');
    if (!queued.length) { job.status = 'completed'; job.finishedAt = Date.now(); await persist(); return; }
    const batch = queued.filter(i => (i.nextAttemptAt || 0) <= Date.now()).slice(0,job.config.concurrency);
    if (!batch.length) { job.status = 'waiting'; job.waitingUntil = Math.min(...queued.map(i => i.nextAttemptAt || 0)); return; }
    running = true;
    const generation = revision, current = job;
    try {
      job.status = 'processing'; job.waitingUntil = null;
      batch.forEach(i => { i.status='processing'; i.attempts=(i.attempts || 0)+1; i.startedAt=Date.now(); });
      await persist();
      const data = await remote('batch', {items:batch.map(i => ({id:i.id,shortUrl:i.shortUrl}))});
      if (generation !== revision || current !== job) return;
      const results = new Map(data.results.map(r => [r.id,r]));
      for (const item of batch) {
        const result = results.get(item.id);
        if (!result) throw new Error('Respons batch tidak lengkap');
        if (result.ok) {
          const {ok,id,...fields} = result;
          Object.assign(item, fields, {status:'success',error:'',finishedAt:Date.now()});
        } else {
          item.error=result.error;
          if (item.attempts <= job.config.maxRetries && !['INVALID_SHORTLINK','NOT_PRODUCT'].includes(result.code)) {
            item.status='queued'; item.nextAttemptAt=Date.now()+ (result.code === 'RATE_LIMIT' ? delay(30000,90000) : delay(5000,12000));
          } else { item.status='failed'; item.finishedAt=Date.now(); }
        }
      }
      if (job.status === 'processing') {
        if (!job.items.some(i => i.status === 'queued')) { job.status='completed'; job.finishedAt=Date.now(); }
        else { job.status='waiting'; job.waitingUntil=Date.now()+delay(job.config.batchDelayMin,job.config.batchDelayMax); }
      }
      await persist();
    } catch (error) {
      if (generation === revision && current === job) {
        batch.forEach(i => { if(i.status === 'processing') {i.status='queued'; i.attempts=Math.max(0,i.attempts-1);} });
        job.status='paused'; job.waitingUntil=null;
        try { await persist(); } catch {}
        toast(error.message);
      }
    } finally { running = false; }
  }
  async function api(url, options = {}) {
    await ready;
    const path = url.replace('/api/shopee/',''), method = options.method || 'GET';
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : {};
    if (path === 'job' && method === 'GET') return {job:clone(job)};
    if (path === 'sessions' && method === 'GET') return {sessions:clone(sessions)};
    if (path === 'start') {
      idleRequired();
      const {rows} = await remote('normalize', {links:body.links});
      if (!rows.length) throw new Error('Tidak ada shortlink Shopee valid');
      revision++;
      const ts=Date.now(), cfg=config(body.config);
      job={jobId:crypto.randomUUID(),status:'processing',createdAt:ts,startedAt:ts,config:cfg,concurrency:cfg.concurrency,
        items:rows.map((r,n) => ({...r,id:`item_${n}_${ts}`,status:'queued',attempts:0,error:'',shopId:'',productId:''}))};
    } else if (path === 'pause') {
      if(job) {job.status='paused'; job.waitingUntil=null;}
    } else if (path === 'resume' || path === 'retry') {
      idleRequired();
      if(!job) throw new Error('Belum ada job');
      job.config=config(job.config);
      if(path === 'retry') job.items.forEach(i => {if(i.status === 'failed') Object.assign(i,{status:'queued',attempts:0,error:'',nextAttemptAt:0});});
      job.status=job.items.some(i => i.status === 'queued') ? 'processing' : job.status;
      job.waitingUntil=null; job.finishedAt=null;
    } else if (path === 'stop') {
      revision++;
      if(job) {job.status='stopped';job.waitingUntil=null;job.finishedAt=Date.now();job.items.forEach(i => {if(['queued','processing'].includes(i.status)) i.status='cancelled';});}
    } else if (path === 'job' && method === 'DELETE') {
      idleRequired(); revision++; job=null;
    } else if (path === 'sessions' && method === 'POST') {
      if(!job) throw new Error('Belum ada job');
      summarize();
      const saved=clone(job); recover(saved);
      sessions=sessions.filter(s => s.jobId !== job.jobId);
      sessions.unshift({id:crypto.randomUUID(),name:body.name || 'Session',jobId:job.jobId,status:saved.status,
        total:job.total,success:job.success,failed:job.failed,savedAt:Date.now(),job:saved});
      sessions=sessions.slice(0,50);
    } else if (path.startsWith('sessions/')) {
      const id=path.split('/')[1];
      if(method === 'DELETE') sessions=sessions.filter(s => s.id !== id);
      else {idleRequired(); const saved=sessions.find(s => s.id === id);if(!saved) throw new Error('Session tidak ditemukan');revision++;job=clone(saved.job);recover(job);}
    } else if (path === 'dedupe') {
      idleRequired(); if(!job) throw new Error('Belum ada job');
      const [active,products]=counts(job.items), seen=new Set(), before=job.items.length;
      job.items=job.items.filter(i => {if(i.productId && seen.has(i.productId)) return false;if(i.productId) seen.add(i.productId);
        i.activeAdCount=i.activeAdCount ?? active.get(i.shopId) ?? 0; i.productAdCount=i.productAdCount ?? products.get(i.productId) ?? 0;return true;});
      await persist(); return {job:clone(job),removed:before-job.items.length};
    } else if (path === 'brand-categories') {
      idleRequired(); if(!job) throw new Error('Belum ada job'); busyBrand=true;
      try {
        for(const shopId of new Set(job.items.map(i => i.shopId).filter(Boolean))) {
          const fields=await remote('brand',{shopId,cookie:body.cookie || ''});
          job.items.forEach(i => {if(i.shopId === shopId) Object.assign(i,fields);}); await persist();
        }
      } finally {busyBrand=false;}
    } else throw new Error('Aksi tidak dikenal');
    await persist(); return {job:clone(job),sessions:clone(sessions)};
  }
  async function restore(payload) {
    await ready; idleRequired();
    const candidate=payload.job || payload;
    if(!candidate || !Array.isArray(candidate.items) || candidate.items.some(i => !i || typeof i.shortUrl !== 'string' || !/^https?:\/\/s\.shopee\.co\.id\//i.test(i.shortUrl))) throw new Error('Session tidak valid');
    revision++;job=clone(candidate); job.jobId=job.jobId || crypto.randomUUID();job.config=config(job.config);recover(job);
    job.items.forEach((i,n) => {i.id=i.id || `import_${n}`;i.adLibraryUrl=i.adLibraryUrl || i.activeAdLink || i.linkIklanAktif || '';});
    await persist();return {job:clone(job)};
  }
  return {api,tick,restore,ready};
})();
