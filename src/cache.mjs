export class ByteCache {
  constructor(maxBytes) { this.maxBytes = maxBytes; this.bytes = 0; this.items = new Map(); }
  get(key) {
    const hit = this.items.get(key);
    if (!hit) return;
    if (hit.expires <= Date.now()) { this.delete(key); return; }
    this.items.delete(key); this.items.set(key, hit);
    return hit.value;
  }
  delete(key) { const old = this.items.get(key); if (old) { this.bytes -= old.size; this.items.delete(key); } }
  set(key, value, ttl) {
    const size = value.body.length + Buffer.byteLength(JSON.stringify(value.headers)) + Buffer.byteLength(key);
    this.delete(key);
    if (ttl <= 0 || size > this.maxBytes) return;
    while (this.bytes + size > this.maxBytes && this.items.size) this.delete(this.items.keys().next().value);
    this.items.set(key, { value, size, expires: Date.now() + ttl }); this.bytes += size;
  }
}
