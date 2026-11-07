const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dir = process.argv[2];
const port = Number(process.argv[3] || 8901);
const clickPs1 = path.join(__dirname, 'click.ps1');

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 20 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(s));
  });
}

http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (urlPath === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (urlPath === '/click' && req.method === 'POST') {
    let x, y;
    try {
      const body = JSON.parse(await readBody(req));
      x = Math.round(Number(body.x));
      y = Math.round(Number(body.y));
      if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 20000 || Math.abs(y) > 20000) throw new Error('bad coords');
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, err: 'bad request' }));
      return;
    }
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', clickPs1, '-x', String(x), '-y', String(y)]);
    let out = '';
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, x, y }));
    };
    ps.stdout.on('data', (d) => { out += d; });
    ps.on('close', (code) => finish(code === 0 && /OK/.test(out)));
    ps.on('error', () => finish(false));
    setTimeout(() => { try { ps.kill(); } catch (e) {} finish(false); }, 8000);
    return;
  }

  if (urlPath === '/save' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const p = String(body.path || '').trim();
      const content = String(body.content == null ? '' : body.content);
      if (!/^[^<>:"|?*]{1,260}\.(csv|json)$/i.test(p) || p.includes('..')) throw new Error('bad path');
      const full = path.isAbsolute(p) ? p : path.join(dir, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, saved: full }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: false, err: String(e.message || e) }));
    }
    return;
  }

  const name = urlPath.replace(/^\/+/, '');
  const file = path.join(dir, name);
  if (!name.endsWith('.user.js') || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log('listening on 127.0.0.1:' + port));
