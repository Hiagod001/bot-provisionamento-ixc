import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

export const hashWebPassword = (password, salt = randomBytes(16).toString('hex')) =>
  `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
export const verifyWebPassword = (password, hash) => {
  const [salt, encoded] = String(hash).split(':');
  if (!/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(encoded || '')) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(encoded, 'hex'));
};

export function createWebServer({ flow, passwordHash, origin, secure = true, ttlMs = 8 * 3600000 }) {
  if (!passwordHash || !origin || (secure && !origin.startsWith('https://'))) throw Error('WEB_PASSWORD_HASH e WEB_ORIGIN HTTPS obrigatorios');
  const sessions = new Map(), attempts = new Map();
  const assets = new Map(['/index.html', '/app.js', '/style.css', '/brand.css', '/uai-logo.png'].map(path => [path, readFileSync(new URL(`../web${path}`, import.meta.url))]));
  const cookie = (value, age) => `web_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const clean = setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) if (s.expires < now && !s.flow.busy) { flow.dispose(s.flow); sessions.delete(key); }
    for (const [key, a] of attempts) if (a.until < now) attempts.delete(key);
  }, 60000);
  clean.unref();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && (path === '/' || assets.has(path))) {
        const key = path === '/' ? '/index.html' : path;
        const body = assets.get(key);
        res.setHeader('Content-Type', key.endsWith('.png') ? 'image/png' : key.endsWith('.js') ? 'text/javascript; charset=utf-8' : key.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
        if (key.endsWith('.png')) { res.setHeader('Cache-Control', 'public, max-age=86400'); res.end(body); return; }
        if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync(body)); }
        else res.end(body);
        return;
      }
      if (req.method === 'POST' && req.headers.origin !== origin) return send(403, { error: 'Origem nao permitida' });
      let body = {};
      if (req.method === 'POST') {
        if (!String(req.headers['content-type']).startsWith('application/json')) return send(415, { error: 'Formato invalido' });
        let raw = '';
        for await (const part of req) { raw += part; if (Buffer.byteLength(raw) > 4096) return send(413, { error: 'Mensagem muito grande' }); }
        body = JSON.parse(raw || '{}');
      }
      if (req.method === 'POST' && path === '/api/login') {
        const key = req.socket.remoteAddress; // Never trust arbitrary X-Forwarded-For headers.
        const a = attempts.get(key);
        if (a && a.until > Date.now() && a.count >= 5) return send(429, { error: 'Aguarde 15 minutos antes de tentar novamente.' });
        if (typeof body.password !== 'string' || body.password.length > 256 || !verifyWebPassword(body.password, passwordHash)) {
          attempts.set(key, { count: a && a.until > Date.now() ? a.count + 1 : 1, until: Date.now() + 900000 });
          return send(401, { error: 'Senha incorreta' });
        }
        if (sessions.size >= 200) return send(503, { error: 'Limite de sessoes. Tente mais tarde.' });
        attempts.delete(key);
        const token = randomBytes(32).toString('hex');
        const s = { flow: flow.create(), expires: Date.now() + ttlMs };
        sessions.set(token, s);
        await flow.dispatch(s.flow, { text: '/start' });
        res.setHeader('Set-Cookie', cookie(token, ttlMs / 1000));
        return send(200, { ok: true });
      }
      const token = /(?:^|;\s*)web_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const s = sessions.get(token);
      if (!s || s.expires < Date.now()) return send(401, { error: 'Sessao expirou. Entre novamente; confira o IXC antes de repetir uma operacao.' });
      if (req.method === 'POST' && path === '/api/logout') {
        if (s.flow.busy) return send(409, { error: 'Aguarde a operacao terminar antes de sair.' });
        flow.dispose(s.flow); sessions.delete(token); res.setHeader('Set-Cookie', cookie('', 0)); return send(200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/state') {
        const after = Number(new URL(req.url, origin).searchParams.get('after') || 0);
        return send(200, { busy: s.flow.busy, messages: s.flow.messages.filter(m => m.id > after), sequence: s.flow.sequence });
      }
      if (req.method === 'POST' && path === '/api/action') {
        if (!/^[a-f0-9-]{36}$/.test(body.requestId || '')) return send(400, { error: 'Solicitacao invalida' });
        // Keep receipts for the entire session: retrying a lost response never repeats a mutation.
        if (s.flow.receipts.has(body.requestId)) return send(202, { accepted: true });
        if (s.flow.busy) return send(409, { error: 'Operacao em andamento. Aguarde.' });
        if (s.flow.receipts.size >= 1000) return send(409, { error: 'Encerre a sessao e entre novamente.' });
        const input = body.input;
        if (!input || Object.keys(input).length !== 1 || !(
          typeof input.text === 'string' && input.text.length > 0 && input.text.length <= 500 ||
          typeof input.callback === 'string' && input.callback.length <= 128 ||
          input.location && Number.isFinite(input.location.latitude) && Math.abs(input.location.latitude) <= 90 && Number.isFinite(input.location.longitude) && Math.abs(input.location.longitude) <= 180
        )) return send(400, { error: 'Entrada invalida' });
        s.flow.receipts.set(body.requestId, true); s.flow.busy = true;
        Promise.resolve().then(() => flow.dispatch(s.flow, input)).catch(() => {}).finally(() => { s.flow.busy = false; });
        return send(202, { accepted: true });
      }
      send(404, { error: 'Nao encontrado' });
    } catch { if (!res.headersSent) send(400, { error: 'Nao foi possivel processar a solicitacao.' }); }
  });
  server.on('close', () => { clearInterval(clean); for (const s of sessions.values()) flow.dispose(s.flow); });
  return server;
}
