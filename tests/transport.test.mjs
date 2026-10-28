import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSitesTransport, transportPolicy } from '../lib/sites-transport.mjs';
import { signedPost } from '../lib/bridge-protocol.mjs';

test('runtime assertion fails closed without strict-public flag; environment or config text is insufficient',async()=>{
 const previous=globalThis.Cloudflare,fetcher=globalThis.fetch;let calls=0;
 try {
   globalThis.fetch=async()=>{calls++;return new Response(null,{status:200});};
   for(const value of [undefined,{}, {compatibilityFlags:{}},{compatibilityFlags:{global_fetch_strictly_public:false}},{compatibilityFlags:{global_fetch_strictly_public:'true'}}]){
     globalThis.Cloudflare=value;const adapter=createSitesTransport();assert.equal(adapter.publicDestinationValidated,false);await assert.rejects(adapter.post('https://example.com/',{headers:{},body:'{}'}),e=>e.reason==='safe_transport_unavailable');
   }assert.equal(calls,0);
 }finally{globalThis.Cloudflare=previous;globalThis.fetch=fetcher;}
});
test('strict-public adapter uses original HTTPS URL, rejects app routing overrides, preserves exact signed bytes',async()=>{
 const previous=globalThis.Cloudflare,fetcher=globalThis.fetch;
 try{
   globalThis.Cloudflare={compatibilityFlags:{global_fetch_strictly_public:true}};let captured;
   globalThis.fetch=async(url,options)=>{captured={url,options};return new Response(null,{status:200});};
   const adapter=createSitesTransport();assert.equal(adapter.publicDestinationValidated,true);assert.equal(transportPolicy().mode,'cloudflare_strict_public');
   await adapter.post('https://receiver.example.com/callback',{headers:{'webhook-id':'fixed'},body:' {"exact":true} ',cf:{resolveOverride:'evil.example'},redirect:'follow'});
   assert.equal(captured.url,'https://receiver.example.com/callback');assert.equal(captured.options.body,' {"exact":true} ');assert.equal(captured.options.redirect,'manual');assert.equal(captured.options.cache,'no-store');assert.equal(captured.options.cf,undefined);assert.equal(captured.options.method,'POST');
   await assert.rejects(adapter.post('http://receiver.example.com/callback',{headers:{},body:'{}'}));
   globalThis.Cloudflare.compatibilityFlags.global_fetch_strictly_public=false;await assert.rejects(adapter.post('https://receiver.example.com/callback',{headers:{},body:'{}'}),e=>e.reason==='safe_transport_unavailable');
 }finally{globalThis.Cloudflare=previous;globalThis.fetch=fetcher;}
});
test('all callback redirects are rejected without a second fetch',async()=>{
 const previous=globalThis.Cloudflare,fetcher=globalThis.fetch;let calls=0;
 try{
   globalThis.Cloudflare={compatibilityFlags:{global_fetch_strictly_public:true}};
   globalThis.fetch=async()=>{calls++;return new Response(null,{status:307,headers:{location:'https://different.example/'}});};
   const sub={id:'sub_test',callback:'https://receiver.example.com/callback',secret:'whsec_'+Buffer.alloc(32,3).toString('base64')};
   await assert.rejects(signedPost(createSitesTransport(),sub,{eventId:'test'},'test'),e=>e.reason==='redirect_blocked');assert.equal(calls,1);
 }finally{globalThis.Cloudflare=previous;globalThis.fetch=fetcher;}
});
