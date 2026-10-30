'use strict';
const CACHE='zyron-shell-v2';
const ASSETS=['./','./index.html','./styles.css','./app.js','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);await cache.addAll(ASSETS);await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{const keys=await caches.keys();await Promise.all(keys.filter(key=>key.startsWith('zyron-shell-')&&key!==CACHE).map(key=>caches.delete(key)));await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  event.respondWith((async()=>{
    try {
      const response=await fetch(request);
      if(response.ok&&response.type==='basic'){const cache=await caches.open(CACHE);cache.put(request,response.clone()).catch(()=>{});}
      return response;
    } catch(error) {
      const cached=await caches.match(request);
      if(cached)return cached;
      if(request.mode==='navigate'){const shell=await caches.match('./index.html');if(shell)return shell;}
      return new Response('Offline resource unavailable',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
    }
  })());
});