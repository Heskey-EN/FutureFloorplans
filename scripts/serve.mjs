import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const types = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const port = Number(process.env.PORT) || 4173;
createServer((request, response) => {
  const safePath = normalize(decodeURIComponent(request.url.split('?')[0])).replace(/^(\.\.[\\/])+/, '');
  let filename = join(root, safePath === '/' ? 'index.html' : safePath);
  if (!filename.startsWith(root)) { response.writeHead(403); return response.end(); }
  if (existsSync(filename) && statSync(filename).isDirectory()) filename = join(filename, 'index.html');
  if (!existsSync(filename)) { response.writeHead(404); return response.end('Not found'); }
  response.writeHead(200, { 'Content-Type': `${types[extname(filename)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
  createReadStream(filename).pipe(response);
}).listen(port, () => console.log(`Future Floor Plans: http://localhost:${port}`));
