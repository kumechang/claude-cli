'use strict';

const fs = require('node:fs');

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が未設定です`);
  return v;
};

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * 案件(project)定義。PROJECTS_FILE (既定 ./projects.json):
 * { "projects": { "<name>": { "workDir": "...", "claudeArgs": ["..."], "timeoutMs": 600000,
 *                              "handlers": [ { "type": "github", ... } ] } } }
 */
function loadProjects(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')).projects || {};
  const projects = {};
  for (const [name, p] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) throw new Error(`不正な案件名: ${name} (${NAME_RE})`);
    projects[name] = {
      name,
      workDir: p.workDir || process.cwd(),
      claudeArgs: p.claudeArgs || [],
      timeoutMs: p.timeoutMs || Number(process.env.CLAUDE_TIMEOUT_MS || 10 * 60 * 1000),
      handlers: p.handlers || [],
    };
  }
  if (!Object.keys(projects).length) throw new Error(`${file} に案件が1つもありません`);
  return projects;
}

module.exports = {
  port: Number(process.env.PORT || 3000),
  authToken: required('API_TOKEN'),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  queueDir: process.env.QUEUE_DIR || './queue', // <queueDir>/<project>/{pending,done,failed}
  maxBodyBytes: 1024 * 1024,
  projects: loadProjects(process.env.PROJECTS_FILE || './projects.json'),
  NAME_RE,
};
