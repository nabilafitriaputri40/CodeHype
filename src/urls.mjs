const tracking = /^(utm_.+|gclid|dclid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl)$/i;
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function isUpstream(u, c) { return c.upstreamAliases.has(u.origin); }
export function cleanUrl(u, c) {
  const out = new URL(u);
  out.hash = '';
  if (c.stripTracking) for (const key of [...out.searchParams.keys()]) if (tracking.test(key)) out.searchParams.delete(key);
  // Sort parameter names, retaining order of repeated values. Never discard page/filter/query values.
  out.searchParams.sort();
  return out;
}
export function rewriteUrl(value, base, c) {
  if (typeof value !== 'string' || !value.trim() || /^(#|data:|blob:|javascript:|mailto:|tel:)/i.test(value.trim())) return value;
  try {
    const u = new URL(value, base);
    if (!isUpstream(u, c)) return value;
    return c.publicOrigin + u.pathname + u.search + u.hash;
  } catch { return value; }
}
export function upstreamUrl(pathAndQuery, c) {
  // Concatenate, never new URL(untrustedPath, origin): //evil.example cannot change the target host.
  if (!pathAndQuery.startsWith('/') || pathAndQuery.startsWith('//') || /[\r\n\\]/.test(pathAndQuery)) throw new Error('Invalid request target');
  const u = new URL(c.upstreamOrigin + pathAndQuery);
  if (u.origin !== c.upstreamOrigin) throw new Error('Invalid upstream host');
  return u;
}
export function canonicalUrl(requestUrl, c, sourceCanonical) {
  let result = new URL(requestUrl.pathname + requestUrl.search, c.upstreamOrigin);
  if (sourceCanonical) {
    try {
      const candidate = new URL(sourceCanonical, result);
      if (isUpstream(candidate, c) && (candidate.pathname !== '/' || result.pathname === '/')) {
        // Preserve meaningful queries if the upstream canonical merely omitted them on the same route.
        if (candidate.pathname === result.pathname) for (const key of new Set(result.searchParams.keys())) {
          if (!candidate.searchParams.has(key) && key !== '_rsc') for (const v of result.searchParams.getAll(key)) candidate.searchParams.append(key, v);
        }
        result = candidate;
      }
    } catch { /* malformed canonical: use the requested route */ }
  }
  result = cleanUrl(result, c);
  result.searchParams.delete('_rsc');
  return (c.canonicalMode === 'upstream' ? c.upstreamOrigin : c.publicOrigin) + result.pathname + result.search;
}
export function rewriteText(text, c) {
  // Only replace exact configured origins at URL boundaries, including escaped JSON/Next Flight strings.
  for (const alias of [...c.upstreamAliases].sort((a,b) => b.length-a.length)) {
    for (const level of [2, 1, 0]) {
      const encode = s => s.replaceAll('/', '\\'.repeat(level) + '/');
      const search = encode(alias);
      const end = level ? `(?=[\\\\/"'<>\\s?#\\x60]|$)` : `(?=[/"'<>\\s?#\\x60\\\\]|$)`;
      text = text.replace(new RegExp(escapeRegExp(search) + end, 'g'), () => encode(c.publicOrigin));
    }
    const host = new URL(alias).host;
    text = text.replace(new RegExp(`(?<![:/])//${escapeRegExp(host)}(?=[/"'<>\\s?#\\x60]|$)`, 'g'), c.publicOrigin);
  }
  return text;
}
export function safeJson(value) { return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029'); }
export function xmlEscape(s) { return s.replaceAll('&', '&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;'); }
