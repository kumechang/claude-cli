'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const config = require('./config');
const jobs = require('./jobs');
const { validate: validateHandlers } = require('./handlers');

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
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, workerRunning: jobs.isRunning() });
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
  validateHandlers(config.projects);
  return server.listen(config.port, () => {
    console.log(`listening on :${config.port}`);
    jobs.start(); // 前回の未実施プロンプトが残っていれば処理再開(空なら即停止)
  });
}

if (require.main === module) listen();
module.exports = { server, listen };
