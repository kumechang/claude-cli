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

// 定数時間比較(長さの違いも漏らさないよう、ハッシュしてから比較する)
const sha = (v) => crypto.createHash('sha256').update(v).digest();
const tokenMatches = (given, want) => crypto.timingSafeEqual(sha(given), sha(want));

/**
 * Bearer トークンの検証。全体の API_TOKEN は全案件で使える。
 * 案件専用トークン(projects.json の tokenEnv)は、その案件だけで使える。
 * 未知の案件名でも、トークンが違えば 401 を返す(案件の有無を漏らさない)。
 */
const authorized = (req, project) => {
  const given = req.headers.authorization || '';
  const want = [`Bearer ${config.authToken}`];
  const cfg = project && Object.hasOwn(config.projects, project) ? config.projects[project] : null;
  if (cfg?.token) want.push(`Bearer ${cfg.token}`);
  return want.map((w) => tokenMatches(given, w)).some(Boolean);
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
    const run = req.method === 'POST' && u.pathname.match(/^\/projects\/([^/]+)\/run$/);
    const job = req.method === 'GET' && u.pathname.match(/^\/projects\/([^/]+)\/jobs\/([\w-]+)$/);
    const project = run ? run[1] : job ? job[1] : null;
    if (!authorized(req, project)) return send(res, 401, { error: 'unauthorized' });

    if (run) {
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

    if (job) {
      if (!Object.hasOwn(config.projects, project)) return send(res, 404, { error: 'unknown project' });
      const st = await jobs.status(project, job[2]);
      return st ? send(res, 200, st) : send(res, 404, { error: 'not found' });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, e.status || 500, { error: e.message });
  }
});

function listen() {
  return server.listen(config.port, config.host, () => {
    console.log(`listening on ${config.host}:${config.port}`);
    health.start({ recover: jobs.kick, reserve: jobs.tryReserve });
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
