const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
let saved,respond, pending;
function context() {
  const db={transaction(){const tx={objectStore(){return {get(){const r={result:structuredClone(saved)};setImmediate(()=>tx.oncomplete());return r;},put(v){saved=structuredClone(v);const r={};setImmediate(()=>tx.oncomplete());return r;}};}};return tx;}};
  const ctx=vm.createContext({structuredClone,crypto:require('node:crypto').webcrypto,AbortSignal,console,toast:()=>{},Date,Math,
    indexedDB:{open(){const req={result:db};setImmediate(()=>req.onsuccess());return req;}},
    fetch:async (url,options)=>{const b=JSON.parse(options.body);if(url.endsWith('normalize')) return {ok:true,json:async()=>({rows:[{shortUrl:'https://s.shopee.co.id/a'}]})};
      if(pending) return new Promise(resolve=>respond=()=>resolve({ok:true,json:async()=>({results:b.items.map(i=>({...i,ok:true,shopId:'1',productId:'2'}))})}));
      return {ok:true,json:async()=>({results:b.items.map(i=>({...i,ok:true,shopId:'1',productId:'2'}))})};}
  });vm.runInContext(fs.readFileSync('static/engine.js','utf8')+';globalThis.e=engine;',ctx);return ctx.e;
}
async function main(){
 let e=context();await e.ready;
 const post=(path,body)=>e.api('/api/shopee/'+path,{method:'POST',body:JSON.stringify(body || {})});
 await post('start',{links:'a',config:{batchDelayMin:0,batchDelayMax:0}});await e.tick();
 let r=await e.api('/api/shopee/job');assert.equal(r.job.status,'completed');assert.equal(r.job.success,1);
 await post('sessions',{name:'test'});assert.equal(saved.sessions.length,1);
 await post('start',{links:'a'});pending=true;
 let t=e.tick();while(!respond) await new Promise(setImmediate);
 await post('pause');respond();await t;r=await e.api('/api/shopee/job');assert.equal(r.job.status,'paused');assert.equal(r.job.success,1);
 respond=null;await post('start',{links:'a'});t=e.tick();while(!respond) await new Promise(setImmediate);
 await post('stop');respond();await t;r=await e.api('/api/shopee/job');assert.equal(r.job.status,'stopped');assert.equal(r.job.cancelled,1);assert.equal(r.job.success,0);
 pending=false;await post('start',{links:'a'});e=context();await e.ready;r=await e.api('/api/shopee/job');assert.equal(r.job.status,'paused');
 await post('resume');await e.tick();r=await e.api('/api/shopee/job');assert.equal(r.job.success,1);
 r.job.items[0].status='failed';await e.restore({job:r.job});await post('retry');await e.tick();r=await e.api('/api/shopee/job');assert.equal(r.job.success,1);
 console.log('PASS: completion, persistent cards, pause in flight, stop in flight, reload recovery, resume, retry');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
