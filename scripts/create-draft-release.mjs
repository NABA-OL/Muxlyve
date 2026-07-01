// Desarrollado por NABA-OL
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const { version } = pkg;
const { owner, repo } = pkg.build.publish;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

if (!token) {
  console.error('GH_TOKEN o GITHUB_TOKEN requerido');
  process.exit(1);
}

const tag = `v${version}`;
const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
  method: 'POST',
  headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ tag_name: tag, name: tag, draft: true }),
});

const data = await res.json();
if (res.ok) {
  console.log(`Draft release creado: ${data.html_url}`);
} else if (data.errors?.some(e => e.code === 'already_exists')) {
  console.log(`Release ${tag} ya existe — OK.`);
} else {
  console.error('Error:', data.message);
  process.exit(1);
}
