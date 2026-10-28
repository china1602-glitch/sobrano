/* Сборка готового Worker: отдельные исходники остаются читаемыми в VS Code. */
import { readFile, writeFile, mkdir, readdir, rm, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root=fileURLToPath(new URL('../',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.txt':'text/plain; charset=utf-8'};
const assets={};
async function add(relative) {
  const bytes=await readFile(path.join(root,relative));const ext=path.extname(relative);
  if(!types[ext])return;
  const binary=['.woff2','.png','.jpg','.jpeg','.webp','.gif'].includes(ext);
  assets['/'+relative]={body:bytes.toString(binary?'base64':'utf8'),binary,type:types[ext]};
}
async function directory(relative) {
  try {
    for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})) {
      if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;
      const p=relative+'/'+entry.name;
      if(entry.isDirectory())await directory(p);else if(entry.isFile())await add(p);
    }
  } catch(error) {if(error.code!=='ENOENT')throw error;}
}
for(const item of await readdir(root))if(/^[a-z]+\.html$/.test(item))await add(item);
for(const dir of ['js','css','data','assets'])await directory(dir);
await writeFile(path.join(root,'online/generated-assets.mjs'),'export const assets = '+JSON.stringify(assets)+';\n');
const output=path.join(root,'dist');
await rm(output,{recursive:true,force:true});
await mkdir(path.join(output,'server'),{recursive:true});
await mkdir(path.join(output,'.openai'),{recursive:true});
await build({entryPoints:[path.join(root,'online/worker.mjs')],outfile:path.join(output,'server/index.js'),
  bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'eof'});
await cp(path.join(root,'.openai/hosting.json'),path.join(output,'.openai/hosting.json'));
await cp(path.join(root,'drizzle'),path.join(output,'drizzle'),{recursive:true});
const source=await readFile(path.join(output,'server/index.js'),'utf8');
const worker=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
if(typeof worker.default?.fetch!=='function')throw Error('Артефакт не экспортирует fetch.');
console.log('Worker собран: '+Object.keys(assets).length+' файлов интерфейса, '+Buffer.byteLength(source)+' байт.');
