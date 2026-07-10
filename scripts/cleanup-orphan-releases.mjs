// Desarrollado por BlacKraken Solutions (NABA-OL)
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

const forTag = releases.filter(r => r.tag_name === tag);

for (const r of forTag) {
  if (r.draft && r.assets.length === 0) {
    // Draft sin assets → huérfano, borrar
    const del = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/${r.id}`, {
      method: 'DELETE',
      headers: { Authorization: `token ${token}` },
    });
    console.log(`Draft huérfano ${r.id} ${del.status === 204 ? 'eliminado.' : 'ya no existe.'}`);
  } else if (r.draft && r.assets.length > 0) {
    // Draft con assets → publicar para que electron-updater lo detecte
    const pub = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/${r.id}`, {
      method: 'PATCH',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: false, make_latest: 'true' }),
    });
    const data = await pub.json();
    console.log(`Release ${r.id} publicado: ${pub.ok ? data.html_url : data.message}`);
  } else {
    console.log(`Release ${r.id} ya está publicado.`);
  }
}

if (!forTag.length) console.log(`Sin releases para ${tag}.`);
