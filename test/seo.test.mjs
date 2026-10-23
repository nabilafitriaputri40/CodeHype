import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { createConfig } from '../src/config.mjs';
import { canonicalUrl, rewriteText, upstreamUrl } from '../src/urls.mjs';
import { transformHtml, transformSitemap, transformRobots } from '../src/seo.mjs';
import { rewriteFlight } from '../src/flight.mjs';
import { ByteCache } from '../src/cache.mjs';
const c=createConfig({PUBLIC_ORIGIN:'https://mirror.example',UPSTREAM_ORIGIN:'https://source.example',UPSTREAM_ALIASES:'http://source.example,https://www.source.example'});
const page=new URL('https://mirror.example/products/widget?page=2&utm_source=ad');

test('canonical strips tracking and retains content query/pagination',()=>{
  assert.equal(canonicalUrl(page,c,'https://source.example/products/widget'),'https://mirror.example/products/widget?page=2');
  assert.equal(canonicalUrl(page,c,'https://source.example/'),'https://mirror.example/products/widget?page=2');
  assert.equal(canonicalUrl(page,c,'https://evil.example/fake'),'https://mirror.example/products/widget?page=2');
});
test('origin replacement has a boundary and handles escaped Next.js strings',()=>{
  assert.equal(rewriteText('https://source.example/x https://source.example.evil/a',c),'https://mirror.example/x https://source.example.evil/a');
  assert.equal(rewriteText('https:\\/\\/source.example\\/x',c),'https:\\/\\/mirror.example\\/x');
  assert.equal(rewriteText('//source.example/a',c),'https://mirror.example/a');
});
test('request target cannot become an open proxy',()=>{
  for(const p of ['//evil.example','/\\evil.example','https://evil.example']) assert.throws(()=>upstreamUrl(p,c));
  assert.equal(upstreamUrl('/image?url=https://images.example/a',c).origin,c.upstreamOrigin);
});
test('single canonical, OG URL, verification, links, schema and HTML escaping',()=>{
  const html=`<!doctype html><html><head><title>Widget</title><link rel="canonical" href="https://source.example/products/widget"><link rel="canonical" href="https://bad.example"><meta property="og:url" content="https://source.example/products/widget"><meta name="google-site-verification" content="old"><script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","url":"https://source.example/products/widget"}</script></head><body><h1>Widget</h1><a href="/products/other">Other</a><a href="https://external.example/">External</a><script>const home="https://source.example/";</script></body></html>`;
  const result=transformHtml(html,page,200,{...c,googleVerification:'mine',overrides:{'/products/widget':{intro:'My <review> & notes'}}});
  const $=cheerio.load(result.html);
  assert.equal($('link[rel=canonical]').length,1);
  assert.equal($('link[rel=canonical]').attr('href'),'https://mirror.example/products/widget?page=2');
  assert.equal($('a').first().attr('href'),'https://mirror.example/products/other');
  assert.equal($('a').last().attr('href'),'https://external.example/');
  assert.equal($('meta[name=google-site-verification]').attr('content'),'mine');
  assert.equal(JSON.parse($('script[type="application/ld+json"]').text()).url,'https://mirror.example/products/widget');
  assert.equal($('[data-mirror-editorial]').text(),'My <review> & notes');
  assert.equal($('[data-mirror-editorial] review').length,0);
});
test('404 and source noindex are preserved, canonical omitted',()=>{
  for(const [status,html] of [[404,'<h1>Not found</h1>'],[200,'<meta name="robots" content="none"><h1>Private</h1>']]){
    const result=transformHtml(html,page,status,c); const $=cheerio.load(result.html);
    assert.equal(result.noindex,true); assert.equal($('link[rel=canonical]').length,0);
    assert.match($('meta[name=robots]').attr('content'),/noindex/);
  }
});
test('invalid JSON-LD is removed, valid breadcrumb repaired without invented labels',()=>{
  const html=`<script type="application/ld+json">{"broken": }</script><script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","@id":"https://source.example/#breadcrumb","itemListElement":[{"position":5,"name":"Home","item":"https://source.example/"},{"position":9,"item":{"name":"Widget","@id":"https://source.example/products/widget"}}]}</script>`;
  const r=transformHtml(html,page,200,c), $=cheerio.load(r.html);
  assert.equal(r.stats.invalidJsonLdRemoved,1);
  const data=JSON.parse($('script[type="application/ld+json"]').text());
  assert.equal(data['@id'],'https://mirror.example/#breadcrumb');
  assert.equal(data.itemListElement[1].position,2);
  assert.equal(data.itemListElement[1].name,'Widget');
  assert.equal(data.itemListElement[0].item,'https://mirror.example/');
});
test('malformed breadcrumb removed and rebuilt only from visible navigation',()=>{
  const html=`<nav aria-label="Breadcrumb"><ol><li><a href="/">Home</a></li><li aria-current="page">Widget</li></ol></nav><script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"name":"Unknown"}]}</script>`;
  const r=transformHtml(html,page,200,c), $=cheerio.load(r.html);
  const data=JSON.parse($('script[type="application/ld+json"]').text());
  assert.equal(data.itemListElement.length,2); assert.equal(data.itemListElement[1].name,'Widget');
});
test('sitemap deduplicates canonical URL, keeps image namespaces, filters foreign/private',()=>{
  const xml=`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url><loc>https://source.example/a?utm_source=x</loc><lastmod>2026-10-19</lastmod><image:image><image:loc>https://source.example/img.png</image:loc></image:image></url><url><loc>https://source.example/a</loc></url><url><loc>https://source.example/search?q=abc</loc></url><url><loc>https://foreign.example/x</loc></url></urlset>`;
  const r=transformSitemap(xml,c.upstreamOrigin,c);
  const $=cheerio.load(r.xml,{xml:true});
  assert.equal(r.entries,1); assert.equal($('url > loc').text(),'https://mirror.example/a');
  assert.match(r.xml,/xmlns:image=/); assert.match(r.xml,/2026-10-19/); assert.match(r.xml,/https:\/\/mirror.example\/img.png/);
});
test('child sitemap registration and safe XML entities',()=>{
  const found=[];
  const r=transformSitemap('<sitemapindex><sitemap><loc>https://source.example/maps/pages.xml?x=1&amp;y=2</loc></sitemap></sitemapindex>',c.upstreamOrigin,c,{register:u=>found.push(u.href)});
  assert.deepEqual(found,['https://source.example/maps/pages.xml?x=1&y=2']); assert.match(r.xml,/mirror.example\/maps\/pages.xml\?x=1&amp;y=2/);
  assert.throws(()=>transformSitemap('<!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><urlset/>',c.upstreamOrigin,c));
  assert.throws(()=>transformSitemap('<html>not a sitemap</html>',c.upstreamOrigin,c));
});
test('robots preserves source groups and discovers custom sitemap',()=>{
  const found=[]; const out=transformRobots('User-agent: *\nDisallow: /private\nSitemap: https://source.example/maps/root.xml\nHost: source.example\n',c,u=>found.push(u.href));
  assert.match(out,/Disallow: \/private/); assert.match(out,/Sitemap: https:\/\/mirror.example\/sitemap.xml/); assert.doesNotMatch(out,/Host:/);
  assert.equal(found.length,1);
});
test('Flight T rows update UTF-8 size and preserve binary rows',()=>{
  const raw='https://source.example/😀';
  const t='a:T'+Buffer.byteLength(raw).toString(16)+','+raw;
  const input=t+'b:O3,abc'+'c:{"url":"https://source.example/"}\n';
  const out=rewriteFlight(input,c); const newRaw='https://mirror.example/😀';
  assert.equal(out,'a:T'+Buffer.byteLength(newRaw).toString(16)+','+newRaw+'b:O3,abc'+'c:{"url":"https://mirror.example/"}\n');
  assert.throws(()=>rewriteFlight('a:Tff,incomplete',c));
});
test('inline Next Flight split across scripts remains a valid stream',()=>{
  const flight='0:{"url":"https://source.example/"}\n1:T'+Buffer.byteLength('https://source.example/x').toString(16)+',https://source.example/x';
  const html=flight.match(/.{1,17}/gs).map(chunk=>'<script>self.__next_f.push('+JSON.stringify([1,chunk])+')</script>').join('');
  const result=transformHtml(html,page,200,c), $=cheerio.load(result.html);
  const joined=$('script').toArray().map(el=>JSON.parse($(el).text().slice('self.__next_f.push('.length,-1))[1]).join('');
  assert.equal(joined,rewriteFlight(flight,c));
});
test('byte cache expires, evicts and never stores oversized content',async()=>{
  const cache=new ByteCache(180); const value={body:Buffer.alloc(80),headers:{}};
  cache.set('a',value,1000); cache.set('b',value,1000); cache.set('c',value,1000);
  assert.equal(cache.get('a'),undefined); assert.ok(cache.bytes<=180);
  cache.set('big',{body:Buffer.alloc(1000),headers:{}},1000); assert.equal(cache.get('big'),undefined);
  cache.set('short',{body:Buffer.alloc(1),headers:{}},1); await new Promise(r=>setTimeout(r,10)); assert.equal(cache.get('short'),undefined);
});
test('production origin is explicit and cannot contain URL path',()=>{
  assert.throws(()=>createConfig({NODE_ENV:'production'}));
  assert.throws(()=>createConfig({PUBLIC_ORIGIN:'https://mirror.example/path'}));
  assert.equal(createConfig({NODE_ENV:'production',RAILWAY_PUBLIC_DOMAIN:'demo.up.railway.app'}).publicOrigin,'https://demo.up.railway.app');
});

test('editorial override keeps SVG labels and prevents Next hydration from discarding original content',()=>{
  const html='<head><title>Original</title></head><body><main><h1>Widget</h1><svg><title>Accessible icon</title></svg></main><script src="/_next/app.js"></script><script>self.__next_f=self.__next_f||[]</script></body>';
  const result=transformHtml(html,page,200,{...c,overrides:{'/products/widget':{title:'My review',intro:'Original testing notes'}}});
  const $=cheerio.load(result.html);
  assert.equal($('head > title').text(),'My review');assert.equal($('svg title').text(),'Accessible icon');
  assert.equal($('script[src]').length,0);assert.equal($('[data-mirror-editorial]').text(),'Original testing notes');
});
