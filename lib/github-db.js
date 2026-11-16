// The "database": one small JSON file per order inside a PRIVATE GitHub repository.
// Use a repository separate from the website's one, otherwise every order would start a new deployment.
import { cfg } from './config.js';
import { validOrderId } from './util.js';

export class Conflict extends Error {}

async function gh(method, path, body) {
  const { github } = cfg();
  const r = await fetch(`https://api.github.com/repos/${github.repo}/contents/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${github.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'reset72h-site',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r;
}
let privacy = { repo: '', ok: false, at: 0 };
// The orders hold customer emails: refuse to work with a public repository.
export async function assertPrivateRepo() {
  const { github } = cfg();
  if (privacy.repo === github.repo && privacy.ok && Date.now() - privacy.at < 10 * 60 * 1000) return;
  const r = await fetch(`https://api.github.com/repos/${github.repo}`, { headers: { Authorization: `Bearer ${github.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'reset72h-site' } });
  if (!r.ok) throw new Error(`GitHub repository ${github.repo} not reachable with this token (${r.status})`);
  const j = await r.json();
  if (j.private !== true) { const e = new Error(`GitHub repository ${github.repo} is PUBLIC: orders contain customer emails, use a private repository`); e.publicRepo = true; throw e; }
  privacy = { repo: github.repo, ok: true, at: Date.now() };
}
const file = (id) => {
  if (!validOrderId(id)) throw new Error('invalid order id');
  return `orders/${id}.json`;
};

// -> { data, sha } or null when the order does not exist
export async function readOrder(id) {
  const { github } = cfg();
  const r = await gh('GET', file(id) + (github.branch ? `?ref=${encodeURIComponent(github.branch)}` : ''));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub read -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content || '', 'base64').toString('utf8')), sha: j.sha };
}

// Writes the order. With "sha" it only succeeds if nobody changed the file in the meantime (-> Conflict otherwise).
export async function writeOrder(id, data, sha, message) {
  const { github } = cfg();
  const r = await gh('PUT', file(id), {
    message: message || `order ${id}: ${data.status}`,
    content: Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
    ...(github.branch ? { branch: github.branch } : {}),
  });
  if (r.status === 409 || r.status === 422) throw new Conflict(`GitHub write conflict (${r.status})`);
  if (!r.ok) throw new Error(`GitHub write -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.content && j.content.sha;
}
