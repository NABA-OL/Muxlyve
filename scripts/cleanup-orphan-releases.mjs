import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const tag = `v${pkg.version}`;
const { owner, repo } = pkg.build.publish;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

if (!token) { console.log('Sin token, saltando limpieza.'); process.exit(0); }

const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
  headers: { Authorization: `token ${token}` },
});
const releases = await res.json();

// Drafts vacíos = sin assets subidos (GitHub agrega source code automáticamente pero no cuenta en assets[])
const orphans = releases.filter(r => r.tag_name === tag && r.draft && r.assets.length === 0);

if (!orphans.length) { console.log('Sin drafts huérfanos.'); process.exit(0); }

for (const r of orphans) {
  const del = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/${r.id}`, {
    method: 'DELETE',
    headers: { Authorization: `token ${token}` },
  });
  console.log(`Draft huérfano ${r.id} ${del.status === 204 ? 'eliminado.' : 'ya no existe.'}`);
}
