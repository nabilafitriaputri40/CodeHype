import { readFileSync } from 'node:fs';

function origin(value, name) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new Error(`${name} must be an http(s) origin without a path, credentials, query, or hash`);
  }
  return u.origin;
}
const bool = (v, fallback) => v === undefined ? fallback : /^(true|1)$/i.test(v);
const num = (v, fallback, min, max) => {
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid numeric setting: ${v}`);
  return n;
};
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
function jsonFile(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${file}: ${e.message}`); }
}
export function createConfig(env = process.env) {
  const port = num(env.PORT, 3000, 1, 65535);
  const upstreamOrigin = origin(env.UPSTREAM_ORIGIN || 'https://www.codehype.ai', 'UPSTREAM_ORIGIN');
  const auto = env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : env.RENDER_EXTERNAL_URL;
  if (env.NODE_ENV === 'production' && !env.PUBLIC_ORIGIN && !auto) throw new Error('Set PUBLIC_ORIGIN=https://your-domain.example before production deployment');
  const publicOrigin = origin(env.PUBLIC_ORIGIN || auto || `http://localhost:${port}`, 'PUBLIC_ORIGIN');
  if (publicOrigin === upstreamOrigin) throw new Error('PUBLIC_ORIGIN must differ from UPSTREAM_ORIGIN');
  const upstreamAliases = new Set([upstreamOrigin, ...list(env.UPSTREAM_ALIASES).map(v => origin(v, 'UPSTREAM_ALIASES'))]);
  const c = {
    port, host: env.HOST || '0.0.0.0', publicOrigin, upstreamOrigin, upstreamAliases,
    canonicalMode: env.CANONICAL_MODE || 'mirror',
    enableIndexing: bool(env.ENABLE_INDEXING, true), trustProxy: bool(env.TRUST_PROXY, true),
    forceHttps: new URL(publicOrigin).protocol === 'https:',
    allowWrite: bool(env.ALLOW_WRITE_METHODS, false), proxyCookies: bool(env.PROXY_COOKIES, false),
    rewriteCsp: bool(env.KEEP_UPSTREAM_CSP, false),
    timeout: num(env.UPSTREAM_TIMEOUT_MS, 20000, 100, 120000),
    maxTextBytes: num(env.MAX_TEXT_BYTES, 16 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    maxBodyBytes: num(env.MAX_REQUEST_BYTES, 8 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    cacheTtl: num(env.HTML_CACHE_SECONDS, 30, 0, 3600) * 1000,
    cacheBytes: num(env.CACHE_MAX_MB, 64, 0, 1024) * 1024 * 1024,
    sitemapTtl: num(env.SITEMAP_CACHE_SECONDS, 300, 0, 86400) * 1000,
    sitemapValidateLimit: num(env.SITEMAP_VALIDATE_LIMIT, 30, 0, 50000),
    sitemapValidationBudget: num(env.SITEMAP_VALIDATION_BUDGET_MS, 8000, 100, 60000),
    sitemapValidationConcurrency: num(env.SITEMAP_VALIDATION_CONCURRENCY, 4, 1, 8),
    sitemapProbeTtl: num(env.SITEMAP_PROBE_TTL_SECONDS, 3600, 1, 86400) * 1000,
    stripTracking: bool(env.STRIP_TRACKING_CANONICAL, true),
    googleVerification: env.GOOGLE_SITE_VERIFICATION || '',
    sitemapPaths: [...new Set(['/sitemap.xml', ...list(env.SITEMAP_PATHS)])],
    noindexPaths: list(env.NOINDEX_PATH_PREFIXES || '/search,/admin,/settings,/my-launches,/auth,/api,/login,/signup,/pricing/checkout,/pricing/success,/pricing/cancel'),
    overrides: jsonFile(env.PAGE_OVERRIDES_FILE || 'config/pages.json', {}),
    redirects: jsonFile(env.REDIRECTS_FILE || 'config/redirects.json', {}),
    verificationFiles: jsonFile(env.VERIFICATION_FILES || 'config/verification-files.json', {}),
    robotsAppend: env.ROBOTS_APPEND || '',
    logRequests: bool(env.LOG_REQUESTS, true)
  };
  if (!['mirror', 'upstream'].includes(c.canonicalMode)) throw new Error('CANONICAL_MODE must be mirror or upstream');
  for (const p of c.sitemapPaths) if (!p.startsWith('/') || p.startsWith('//') || /[?#]/.test(p)) throw new Error('SITEMAP_PATHS must contain absolute paths only');
  return c;
}
export function pathIsNoindex(path, c) {
  return c.noindexPaths.some(p => path === p || path.startsWith(p.endsWith('/') ? p : p + '/'));
}
