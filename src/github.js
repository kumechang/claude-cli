'use strict';

const { github } = require('./config');

async function api(method, path, body) {
  const res = await fetch(`${github.apiUrl}/repos/${github.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${github.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-cli-server',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new Error(`GitHub API ${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Contents API でファイルを作成/更新(コミット)する。 */
async function pushFile(path, content, message) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const existing = await api('GET', `/contents/${encodedPath}?ref=${encodeURIComponent(github.branch)}`);
  const res = await api('PUT', `/contents/${encodedPath}`, {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: github.branch,
    ...(existing?.sha ? { sha: existing.sha } : {}),
  });
  return { commitSha: res.commit.sha, url: res.content.html_url };
}

module.exports = { pushFile };
