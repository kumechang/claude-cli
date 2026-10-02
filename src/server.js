'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const config = require('./config');
const jobs = require('./jobs');
const health = require('./health');

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const authorized = (req) => {
  const given = Buffer.from(req.headers.authorization || '');
  const want = Buffer.from(`Bearer ${config.authToken}`);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if ((req.method === 'GET' || req.method === 'HEAD') && u.pathname === '/healthz') {
      // 死活監視(UptimeRobot 等)用。認証不要。通常は 200。?strict=1 なら claude の認証異常時に 503。
      const { ok, kind, checkedAt } = health.snapshot();
      const code = u.searchParams.get('strict') && !ok ? 503 : 200;
      return send(res, code, { ok: true, workerRunning: jobs.isRunning(), claude: { ok, kind, checkedAt } });
    }
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

    const run = req.method === 'POST' && req.url.match(/^\/projects\/([^/]+)\/run$/);
    if (run) {
      const project = run[1];
      if (!Object.hasOwn(config.projects, project)) return send(res, 404, { error: 'unknown project' });
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        if (e.status) throw e;
        return send(res, 400, { error: 'invalid JSON' });
      }
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
        return send(res, 400, { error: '"prompt" (string) is required' });
      }
      const id = await jobs.enqueue(project, body.prompt);
      return send(res, 202, { project, id, status: 'queued', statusUrl: `/projects/${project}/jobs/${id}` });
    }

    const m = req.method === 'GET' && req.url.match(/^\/projects\/([^/]+)\/jobs\/([\w-]+)$/);
    if (m) {
      if (!Object.hasOwn(config.projects, m[1])) return send(res, 404, { error: 'unknown project' });
      const job = await jobs.status(m[1], m[2]);
      return job ? send(res, 200, job) : send(res, 404, { error: 'not found' });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

function listen() {
  return server.listen(config.port, () => {
    console.log(`listening on :${config.port}`);
    health.start({ recover: jobs.start });
    jobs.start(); // 前回の未実施/未送信が残っていれば再開(なければ即停止)
  });
}

if (require.main === module) {
  listen();
  let closing = false;
  const graceful = async (sig) => {
    if (closing) return;
    closing = true;
    console.log(`${sig}: 新規受付を停止し、実行中のジョブの完了を待ちます`);
    server.close();
    health.stop();
    await jobs.shutdown(); // 未実施は pending に残り、次回起動時に再開される
    process.exit(0);
  };
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => graceful(sig));
}
module.exports = { server, listen };
