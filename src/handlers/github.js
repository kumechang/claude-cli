'use strict';

/**
 * 結果を GitHub Contents API でコミットする。
 * options: { repo: "owner/name", branch?: "main", dir?: "results", tokenEnv?: "GITHUB_TOKEN", apiUrl? }
 */
module.exports = async function github({ id, markdown, options: o }) {
  const token = process.env[o.tokenEnv || 'GITHUB_TOKEN'];
  if (!token) throw new Error(`環境変数 ${o.tokenEnv || 'GITHUB_TOKEN'} が未設定です`);
  if (!o.repo) throw new Error('github handler: "repo" が必要です');
  const branch = o.branch || 'main';
  const base = `${o.apiUrl || process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${o.repo}`;
  const file = `${o.dir || 'results'}/${id}.md`;
  const path = `/contents/${file.split('/').map(encodeURIComponent).join('/')}`;

  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'claude-cli-server',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) throw new Error(`GitHub API ${method} ${url} -> ${res.status}: ${await res.text()}`);
    return res.json();
  };

  const existing = await call('GET', `${path}?ref=${encodeURIComponent(branch)}`);
  const res = await call('PUT', path, {
    message: `claude result ${id}`,
    content: Buffer.from(markdown, 'utf8').toString('base64'),
    branch,
    ...(existing?.sha ? { sha: existing.sha } : {}),
  });
  return { commitSha: res.commit.sha, url: res.content.html_url };
};
