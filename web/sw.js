'use strict';
const CACHE='zyron-shell-v3';
const ASSETS=['./index.html','./styles.css','./app.js','./manifest.webmanifest','./icon.svg'];

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await Promise.all(ASSETS.map(async asset=>{
      try {
        const response=await fetch(new Request(asset,{cache:'reload'}));
        if(response.ok&&response.type==='basic') await cache.put(asset,response);
      } catch(error) {
        console.warn('ZYRON precache skipped:',asset,error);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(key=>key.startsWith('zyron-shell-')&&key!==CACHE).map(key=>caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  const url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin) return;

  // Always request HTML from the live deployment. This avoids pinning visitors
  // to an outdated page after a deployment.
  if(request.mode==='navigate') return;

  // Only cache the app's own static shell files; never cache API or user data.
  const isShellAsset=ASSETS.some(asset=>new URL(asset,self.registration.scope).pathname===url.pathname);
  if(!isShellAsset) return;

  event.respondWith((async()=>{
    try {
      const response=await fetch(request,{cache:'no-store'});
      if(response.ok&&response.type==='basic') {
        const cache=await caches.open(CACHE);
        await cache.put(request,response.clone()).catch(()=>{});
      }
      return response;
    } catch(error) {
      const cached=await caches.match(request);
      if(cached) return cached;
      return new Response('This resource is temporarily unavailable. Please reconnect and reload.',{
        status:503,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}
      });
    }
  })());
});
