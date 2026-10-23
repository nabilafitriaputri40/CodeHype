import * as cheerio from 'cheerio';
import { canonicalUrl, isUpstream } from './urls.mjs';
import { fetchFollowing, readLimited } from './upstream.mjs';

export class SitemapProbe {
  constructor(c) { this.c=c; this.results=new Map(); this.cursors=new Map(); }
  resolve = url => {
    const value=this.results.get(url.href);
    if(!value || value.expires<Date.now())return url;
    return value.url===false ? false : new URL(value.url);
  };
  async validate(xml,base) {
    const c=this.c;
    if(!c.sitemapValidateLimit)return {checked:0,remaining:0};
    const $=cheerio.load(xml,{xml:true}), root=$.root().children().first();
    if(root[0]?.name?.split(':').at(-1)!=='urlset')return {checked:0,remaining:0};
    const urls=[];
    root.children().each((_,el)=>{
      const loc=$(el).children().filter((_,n)=>n.name?.split(':').at(-1)==='loc').first().text();
      try{
        const u=new URL(loc,base);
        if(isUpstream(u,c))urls.push(u);
      }catch{}
    });
    const all=[...new Map(urls.map(u=>[u.href,u])).values()];
    const cursor=(this.cursors.get(base)||0)%Math.max(all.length,1);
    const tasks=[...all.slice(cursor),...all.slice(0,cursor)].filter(u=>{const prior=this.results.get(u.href);return !prior||prior.expires<Date.now();});
    const selected=tasks.slice(0,c.sitemapValidateLimit);
    let next=0,checked=0;
    const deadline=AbortSignal.timeout(c.sitemapValidationBudget);
    const worker=async()=>{
      while(next<selected.length&&!deadline.aborted){
        const target=selected[next++];
        try{
          const {response,url}=await fetchFollowing(target,c,{signal:AbortSignal.any([deadline,AbortSignal.timeout(c.timeout)]),headers:{accept:'text/html,application/xml;q=0.8,*/*;q=0.5','accept-encoding':'identity'}});
          let result;
          if([404,410].includes(response.status))result=false;
          else if(response.status===200){
            if(/\b(noindex|none)\b/i.test(response.headers.get('x-robots-tag')||''))result=false;
            else if((response.headers.get('content-type')||'').includes('text/html')){
              const html=(await readLimited(response,c.maxTextBytes)).toString('utf8'), page=cheerio.load(html);
              const noindex=page('meta[name]').toArray().some(el=>/^(robots|googlebot)$/i.test(page(el).attr('name')||'')&&/\b(noindex|none)\b/i.test(page(el).attr('content')||''));
              if(noindex)result=false;
              else {
                const canonical=canonicalUrl(url,c,page('link[rel~="canonical"]').first().attr('href'));
                const u=new URL(canonical);
                result=c.upstreamOrigin+u.pathname+u.search;
              }
            } else result=c.upstreamOrigin+url.pathname+url.search;
          }
          await response.body?.cancel().catch(()=>{});
          if(result!==undefined){
            if(this.results.size>=10000&&!this.results.has(target.href))this.results.delete(this.results.keys().next().value);
            this.results.set(target.href,{url:result,expires:Date.now()+c.sitemapProbeTtl});checked++;
          }
        }catch(e){if(!deadline.aborted)console.warn(JSON.stringify({event:'sitemap_probe_failed',path:target.pathname,message:e.message}));}
      }
    };
    await Promise.all(Array.from({length:Math.min(c.sitemapValidationConcurrency,selected.length)},worker));
    if(next>0 && all.length){const last=selected[Math.min(next,selected.length)-1];this.cursors.set(base,(all.findIndex(u=>u.href===last.href)+1)%all.length);}
    return {checked,remaining:tasks.length-checked};
  }
}
