import { gunzipSync } from 'node:zlib';
import { fetchFollowing, readLimited } from './upstream.mjs';
import { isUpstream, xmlEscape } from './urls.mjs';
import { transformRobots, transformSitemap } from './seo.mjs';
import { SitemapProbe } from './sitemap-probe.mjs';
import { ByteCache } from './cache.mjs';

export class Sitemaps {
  constructor(c) {
    this.c = c; this.paths = new Set(c.sitemapPaths); this.roots = new Set(c.sitemapPaths);
    this.cache = new ByteCache(Math.min(c.cacheBytes, 64*1024*1024));
    this.probe = new SitemapProbe(c);
    this.discoveryExpires = 0; this.discoveryPromise = null; this.robots = '';
  }
  register = u => { if (isUpstream(u, this.c)) this.paths.add(u.pathname + u.search); };
  async discover() {
    if (this.discoveryExpires > Date.now()) return;
    if (this.discoveryPromise) return this.discoveryPromise;
    this.discoveryPromise = (async () => {
      try {
        const {response} = await fetchFollowing(this.c.upstreamOrigin + '/robots.txt', this.c, { signal:AbortSignal.timeout(this.c.timeout), headers:{'accept-encoding':'identity'} });
        if (response.status === 200) {
          this.robots = (await readLimited(response, 1024*1024)).toString('utf8');
          for (const match of this.robots.matchAll(/^\s*Sitemap\s*:\s*(\S+)/gim)) {
            try { const u = new URL(match[1], this.c.upstreamOrigin); if (isUpstream(u,this.c)) { this.register(u); this.roots.add(u.pathname+u.search); } } catch {}
          }
        } else await response.body?.cancel();
      } catch (e) { console.warn(JSON.stringify({event:'robots_discovery_failed',message:e.message})); }
      this.discoveryExpires = Date.now() + Math.max(this.c.sitemapTtl, 30000);
    })().finally(() => { this.discoveryPromise = null; });
    return this.discoveryPromise;
  }
  async robotsText() {
    await this.discover();
    const base = transformRobots(this.robots, this.c, this.register);
    const already = new Set([...base.matchAll(/^Sitemap:\s*(\S+)/gim)].map(m=>m[1]));
    return base + [...this.roots].map(p => this.c.publicOrigin+p).filter(v=>!already.has(v)).map(v=>'Sitemap: '+v+'\n').join('');
  }
  isSitemap(path) { return this.paths.has(path) || /\.xml\.gz(?:\?|$)/i.test(path) || /(?:^|\/)sitemap[^/]*\.(?:xml|txt)(?:\.gz)?(?:\?|$)/i.test(path); }
  async get(path) {
    const c = this.c;
    const hit = this.cache.get(path);
    if (hit) return hit;
    await this.discover();
    const target = new URL(c.upstreamOrigin + path);
    if (target.origin !== c.upstreamOrigin) throw new Error('Invalid sitemap origin');
    const {response, url} = await fetchFollowing(target, c, {signal:AbortSignal.timeout(c.timeout), headers:{'accept-encoding':'identity'}});
    if (response.status !== 200) {
      await response.body?.cancel();
      // If the source declares a different root in robots.txt, expose it through a local index.
      const other = [...this.roots].filter(p=>p!==path);
      if (path === '/sitemap.xml' && response.status === 404 && other.length) {
        const xml = '<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + other.map(p=>`<sitemap><loc>${xmlEscape(c.publicOrigin+p)}</loc></sitemap>`).join('') + '</sitemapindex>';
        return this.store(path,xml);
      }
      if (response.status === 404 || response.status === 410) return {status:response.status,body:Buffer.from('Sitemap not found\n'),headers:{'content-type':'text/plain; charset=utf-8','x-robots-tag':'noindex','cache-control':'no-store'}};
      throw new Error(`Upstream sitemap HTTP ${response.status}`);
    }
    let bytes = await readLimited(response,c.maxTextBytes);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes,{maxOutputLength:c.maxTextBytes});
    const raw = bytes.toString('utf8');
    const progress = await this.probe.validate(raw,url.href);
    const {xml} = transformSitemap(raw,url.href,c,{register:this.register,resolvePage:this.probe.resolve});
    if(progress.checked) console.log(JSON.stringify({event:'sitemap_validated',path,checked:progress.checked,remaining:progress.remaining}));
    return this.store(path,xml);
  }
  store(path,xml) {
    const value = {status:200,body:Buffer.from(xml),headers:{'content-type':'application/xml; charset=utf-8','cache-control':`public, max-age=${Math.floor(this.c.sitemapTtl/1000)}`,'x-content-type-options':'nosniff'}};
    this.cache.set(path,value,this.c.sitemapTtl); return value;
  }
}
