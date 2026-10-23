import { isUpstream } from './urls.mjs';

const hop = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
export function requestHeaders(req, c) {
  const headers = new Headers();
  const extraHop = new Set((req.headers.connection || '').toLowerCase().split(',').map(v => v.trim()));
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || hop.has(key) || extraHop.has(key) || ['host','content-length','accept-encoding','forwarded'].includes(key) || key.startsWith('x-forwarded-') || key.startsWith('cf-') || key.startsWith('sec-fetch-')) continue;
    if (['if-none-match','if-modified-since','if-match','if-unmodified-since'].includes(key)) continue;
    if (key === 'cookie' && !c.proxyCookies) continue;
    if (key === 'authorization' && !c.allowWrite) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('accept-encoding', 'identity');
  if (headers.get('origin') === c.publicOrigin) headers.set('origin', c.upstreamOrigin);
  const ref = headers.get('referer');
  if (ref) { try { const u = new URL(ref); if (u.origin === c.publicOrigin) headers.set('referer', c.upstreamOrigin + u.pathname + u.search); } catch { headers.delete('referer'); } }
  return headers;
}
export function responseHeaders(response, c) {
  const result = {};
  const extraHop = new Set((response.headers.get('connection') || '').toLowerCase().split(',').map(v => v.trim()));
  for (const [key,value] of response.headers) {
    if (hop.has(key) || extraHop.has(key) || ['content-length','content-encoding','set-cookie','alt-svc','refresh','report-to','nel'].includes(key)) continue;
    if (!c.rewriteCsp && ['content-security-policy','content-security-policy-report-only'].includes(key)) continue;
    // Canonical/preload Link headers can conflict with the rewritten HTML. DOM resource hints remain intact.
    if (key === 'link') continue;
    result[key] = value;
  }
  result['x-content-type-options'] = 'nosniff';
  result['referrer-policy'] ||= 'strict-origin-when-cross-origin';
  if (c.proxyCookies && response.headers.getSetCookie) {
    const cookies = response.headers.getSetCookie().map(v => v.replace(/;\s*Domain=[^;]+/ig, ''));
    if (cookies.length) result['set-cookie'] = cookies;
  }
  return result;
}
export async function readLimited(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), parts = [];
  let length = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw Object.assign(new Error('Upstream text exceeds MAX_TEXT_BYTES; no partial content served'), { code: 'TEXT_TOO_LARGE' });
      parts.push(Buffer.from(value));
    }
  } catch (err) { await reader.cancel().catch(() => {}); throw err; }
  finally { reader.releaseLock(); }
  return Buffer.concat(parts, length);
}
export async function fetchFollowing(url, c, init = {}, maxRedirects = 5) {
  let current = new URL(url);
  for (let i=0; i<=maxRedirects; i++) {
    if (!isUpstream(current,c)) throw new Error('Cross-host upstream redirect blocked');
    const response = await fetch(current, { ...init, redirect:'manual' });
    if ([301,302,303,307,308].includes(response.status) && response.headers.has('location')) {
      const next = new URL(response.headers.get('location'), current);
      await response.body?.cancel();
      if (i === maxRedirects) throw new Error('Upstream redirect limit exceeded');
      current = next; continue;
    }
    return { response, url: current };
  }
}
