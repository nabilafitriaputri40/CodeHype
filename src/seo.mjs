import * as cheerio from 'cheerio';
import { XMLValidator } from 'fast-xml-parser';
import { rewriteInlineFlight } from './flight.mjs';
import { pathIsNoindex } from './config.mjs';
import { canonicalUrl, cleanUrl, isUpstream, rewriteText, rewriteUrl, safeJson } from './urls.mjs';

const typeIs = (obj, type) => [obj?.['@type']].flat().includes(type);
function repairJsonLd(node, base, canonical, c, stats) {
  if (Array.isArray(node)) return node.map(v => repairJsonLd(v, base, canonical, c, stats)).filter(v => v !== undefined);
  if (node && typeof node === 'object') {
    if (typeIs(node, 'BreadcrumbList')) {
      if (!Array.isArray(node.itemListElement) || node.itemListElement.length < 2) { stats.breadcrumbsRemoved++; return; }
      const items = [];
      for (const [i, entry] of node.itemListElement.entries()) {
        const rawItem = entry.item;
        const name = entry.name || (typeof rawItem === 'object' && rawItem?.name);
        let item = typeof rawItem === 'string' ? rawItem : rawItem?.['@id'] || rawItem?.url;
        if (!item && i === node.itemListElement.length - 1) item = canonical;
        if (typeof name !== 'string' || !name.trim() || typeof item !== 'string') { stats.breadcrumbsRemoved++; return; }
        try {
          const u = new URL(item, base);
          if (!['http:', 'https:'].includes(u.protocol)) throw new Error('invalid breadcrumb URL');
          items.push({ '@type': 'ListItem', position: i + 1, name: name.trim(), item: rewriteUrl(u.href, base, c) });
        } catch { stats.breadcrumbsRemoved++; return; }
      }
      stats.breadcrumbsRepaired++;
      const fixed = { itemListElement: items };
      for (const [key,value] of Object.entries(node)) if(key !== 'itemListElement') {
        const v = repairJsonLd(value,base,canonical,c,stats); if(v !== undefined) fixed[key] = v;
      }
      return fixed;
    }
    const result = {};
    for (const [key, value] of Object.entries(node)) {
      const v = repairJsonLd(value, base, canonical, c, stats);
      if (v !== undefined) result[key] = v;
    }
    return result;
  }
  return typeof node === 'string' ? rewriteText(node, c) : node;
}
function visibleBreadcrumbs($, base, canonical, c) {
  const containers = $('nav[aria-label], [itemtype], .breadcrumb, .breadcrumbs').filter((_, el) => {
    const x = $(el);
    return /breadcrumb/i.test(x.attr('aria-label') || '') || /BreadcrumbList/.test(x.attr('itemtype') || '') || x.hasClass('breadcrumb') || x.hasClass('breadcrumbs');
  });
  for (const el of containers.toArray()) {
    const x = $(el), entries = [];
    x.find('a[href]').each((_, a) => {
      const name = $(a).text().trim();
      const item = rewriteUrl($(a).attr('href'), base, c);
      if (name && /^https?:\/\//.test(item || '')) entries.push({ '@type': 'ListItem', name, item });
    });
    const current = x.find('[aria-current="page"], li:last-child, [itemprop="itemListElement"]:last-child').last();
    const name = current.text().trim();
    if (name && entries.at(-1)?.item !== canonical && name !== entries.at(-1)?.name) entries.push({ '@type': 'ListItem', name, item: canonical });
    if (entries.length >= 2) return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: entries.map((v,i) => ({...v,position:i+1})) };
  }
}
export function transformHtml(html, requestUrl, status, c) {
  const $ = cheerio.load(html);
  let base = new URL(requestUrl.pathname + requestUrl.search, c.upstreamOrigin).href;
  try { if ($('base[href]').length) base = new URL($('base[href]').first().attr('href'), base).href; } catch {}
  const sourceCanonical = $('link[rel~="canonical"]').first().attr('href');
  const canonical = canonicalUrl(requestUrl, c, sourceCanonical);
  const sourceNoindex = $('meta[name]').toArray().some(el => /^(robots|googlebot)$/i.test($(el).attr('name')) && /\b(noindex|none)\b/i.test($(el).attr('content') || ''));
  const noindex = !c.enableIndexing || status !== 200 || sourceNoindex || pathIsNoindex(requestUrl.pathname, c);
  const stats = { invalidJsonLdRemoved: 0, breadcrumbsRemoved: 0, breadcrumbsRepaired: 0 };
  // Only absolute upstream URLs are remapped; relative ones already resolve on the mirror and must stay
  // byte-identical (Turbopack matches chunk <script src> attributes against its manifest to boot React).
  const attrs = ['href','src','action','poster','data-src','itemid','cite','formaction','data-href'];
  const isAbsolute = v => /^\s*(?:[a-z][a-z\d+.-]*:|\/\/|\\\\)/i.test(v);
  $('*').each((_, el) => {
    const x = $(el);
    for (const attr of attrs) if (x.attr(attr) !== undefined && isAbsolute(x.attr(attr))) x.attr(attr, rewriteUrl(x.attr(attr), base, c));
    for (const attr of ['style','srcset','imagesrcset']) if (x.attr(attr) !== undefined) x.attr(attr, rewriteText(x.attr(attr), c));
    // Relative srcset URLs already resolve on the mirrored route; absolute source origins are remapped above.
    if (x.attr('content') && /^(og:|twitter:)/i.test(x.attr('property') || x.attr('name') || '')) x.attr('content', rewriteText(x.attr('content'), c));
    // Subresource integrity no longer matches scripts/styles whose source-origin strings can change.
    const ref = x.attr('src') || x.attr('href') || '';
    if (x.attr('integrity') && ['script','link'].includes(el.tagName) && (!isAbsolute(ref) || ref.startsWith(c.publicOrigin + '/'))) x.removeAttr('integrity');
  });
  // Google OAuth cannot complete on the mirror domain (Supabase redirect allowlist), so hide that option.
  $('head').append('<style data-mirror-hide-google>button:has(> svg > path[fill="#4285F4"]),button:has(> svg > path[fill="#4285F4"]) + div:has(> span){display:none!important}</style>');
  $('meta[http-equiv]').each((_,el)=>{ if(/^refresh$/i.test($(el).attr('http-equiv')||'')) $(el).attr('content',rewriteText($(el).attr('content')||'',c)); });
  $('style').each((_, el) => { $(el).text(rewriteText($(el).text(), c)); });
  const flightHandled = rewriteInlineFlight($, c);
  $('script').each((_, el) => {
    const x = $(el);
    if (/^application\/ld\+json(?:;|$)/i.test(x.attr('type') || '')) {
      try {
        let raw = x.html().trim().replace(/^\uFEFF/, '').replace(/^<!--\s*|\s*-->$/g, '');
        let data;
        try { data = JSON.parse(raw); }
        catch { data = JSON.parse(cheerio.load('<textarea></textarea>')('textarea').html(raw).text()); }
        const fixed = repairJsonLd(data, base, canonical, c, stats);
        if (fixed === undefined || (Array.isArray(fixed) && !fixed.length)) x.remove();
        else x.text(safeJson(fixed));
      } catch { stats.invalidJsonLdRemoved++; x.remove(); }
    } else if (!x.attr('src') && !flightHandled.has(el) && !(x.html() || '').includes('__next_f')) x.text(rewriteText(x.html() || '', c));
  });
  // Rebuild legacy breadcrumb microdata from the labels and links visible to every visitor.
  const legacy = $('[itemtype]').filter((_,el) => /BreadcrumbList/.test($(el).attr('itemtype') || ''));
  const breadcrumb = visibleBreadcrumbs($, base, canonical, c);
  legacy.each((_,el) => {
    $(el).find('*').addBack().each((_,n) => { for (const a of ['itemscope','itemtype','itemprop','itemid']) $(n).removeAttr(a); });
  });
  if (breadcrumb && (!stats.breadcrumbsRepaired || legacy.length)) {
    // Existing valid JSON-LD breadcrumb is sufficient, even if legacy microdata was present.
    if (!stats.breadcrumbsRepaired) $('head').append($('<script type="application/ld+json"></script>').text(safeJson(breadcrumb)));
  }
  $('link[rel~="canonical"]').remove();
  $('meta[property="og:url"], meta[name="twitter:url"]').remove();
  if (status === 200 && !noindex) {
    $('head').append($('<link rel="canonical">').attr('href', canonical));
    $('head').append($('<meta property="og:url">').attr('content', canonical));
  }
  $('meta[name="google-site-verification"]').remove();
  if (c.googleVerification) $('head').append($('<meta name="google-site-verification">').attr('content', c.googleVerification));
  if (noindex) {
    $('meta[name="robots"]').remove();
    $('head').append('<meta name="robots" content="noindex, follow">');
  }
  const override = c.overrides[requestUrl.pathname];
  if (override && status === 200) {
    // Editorial markup changes React-owned HTML. Serve that opted-in page as static HTML
    // unless the operator explicitly accepts and tests hydration through renderMode=interactive.
    const hasNext = html.includes('__next_f') || html.includes('/_next/');
    if (hasNext && override.renderMode !== 'interactive') {
      $('script').each((_,el)=>{ if(!/^application\/ld\+json(?:;|$)/i.test($(el).attr('type')||'')) $(el).remove(); });
    }
    if (override.title) { $('head > title').remove(); $('head').append($('<title></title>').text(override.title)); }
    if (override.description) {
      $('meta[name="description"]').remove();
      $('head').append($('<meta name="description">').attr('content', override.description));
    }
    if (override.h1 && $('h1').length) $('h1').first().text(override.h1);
    if (override.intro || override.paragraphs?.length) {
      const section = $('<section data-mirror-editorial="true" style="max-width:72rem;margin:1.5rem auto;padding:1rem;line-height:1.7"></section>');
      if (override.heading) section.append($('<h2></h2>').text(override.heading));
      for (const p of [override.intro, ...(override.paragraphs || [])].filter(Boolean)) section.append($('<p></p>').text(p));
      if ($('main').length) $('main').first().prepend(section); else $('body').prepend(section);
    }
  }
  return { html: $.html(), canonical, noindex, stats };
}
export function transformSitemap(xml, base, c, { register = () => {}, resolvePage = u => u } = {}) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Sitemap DTD/entities are not supported');
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error(`Invalid XML sitemap: ${validation.err.msg}`);
  const $ = cheerio.load(xml, { xml: true });
  const root = $.root().children().first();
  const rootName = root[0]?.name?.split(':').at(-1);
  if (!['urlset','sitemapindex'].includes(rootName)) throw new Error('Expected urlset or sitemapindex');
  const children = root.children().toArray();
  if (children.length > 50000) throw new Error('Sitemap exceeds 50,000 entries; split at upstream');
  const seen = new Set();
  for (const el of children) {
    const entry = $(el);
    const loc = entry.children().filter((_,n) => n.name?.split(':').at(-1) === 'loc').first();
    if (!loc.length) { entry.remove(); continue; }
    let u;
    try { u = new URL(loc.text().trim(), base); } catch { entry.remove(); continue; }
    if (!isUpstream(u, c)) { entry.remove(); continue; }
    if (rootName === 'urlset') {
      u = resolvePage(u);
      if (!u || pathIsNoindex(u.pathname, c)) { entry.remove(); continue; }
    }
    const out = cleanUrl(u, c);
    if (rootName === 'sitemapindex') {
      register(u);
      // Child maps must be fetched from our mirror even when CANONICAL_MODE=upstream.
      loc.text(c.publicOrigin + out.pathname + out.search);
    } else loc.text((c.canonicalMode === 'upstream' ? c.upstreamOrigin : c.publicOrigin) + out.pathname + out.search);
    if (seen.has(loc.text())) { entry.remove(); continue; }
    seen.add(loc.text());
  }
  // Rewrite image/video locations and hreflang URLs while preserving all extension namespaces and lastmod.
  root.find('*').each((_, el) => {
    const x = $(el);
    if (!x.children().length && /^(loc|thumbnail_loc|player_loc|content_loc)$/.test(el.name?.split(':').at(-1))) x.text(rewriteText(x.text(), c));
    if (x.attr('href')) x.attr('href', rewriteUrl(x.attr('href'), base, c));
  });
  // Main page loc in upstream canonical mode is intentionally upstream.
  if (c.canonicalMode === 'upstream' && rootName === 'urlset') for (const el of root.children().toArray()) {
    const loc = $(el).children('loc');
    if (loc.length) loc.text(loc.text().replace(c.publicOrigin, c.upstreamOrigin));
  }
  return { xml: $.xml(), kind: rootName, entries: seen.size };
}
export function transformRobots(text, c, register) {
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*Sitemap\s*:\s*(\S+)/i.exec(line);
    if (match) {
      try { const u = new URL(match[1], c.upstreamOrigin); if (isUpstream(u,c)) register(u); } catch {}
      continue;
    }
    if (!/^\s*Host\s*:/i.test(line)) lines.push(rewriteText(line,c));
  }
  // Preserve upstream groups/disallows. noindex is implemented in page headers/meta, not a robots.txt pseudo-rule.
  if (!lines.some(s => /^\s*User-agent\s*:/i.test(s))) lines.unshift('User-agent: *', 'Allow: /');
  lines.push('', 'Sitemap: ' + c.publicOrigin + '/sitemap.xml');
  for (const p of c.sitemapPaths.filter(v => v !== '/sitemap.xml')) lines.push('Sitemap: ' + c.publicOrigin + p);
  if (c.robotsAppend) lines.push('', c.robotsAppend.replaceAll('\\n','\n'));
  return lines.join('\n').trim() + '\n';
}
