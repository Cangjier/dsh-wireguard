import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function buildNode(entry, outfile) {
  const result = await build({
    entryPoints: [path.join(root, entry)],
    write: false,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  });
  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new Error(`Build produced no output for ${entry}`);
  await writeFile(path.join(root, outfile), code, 'utf8');
}

async function buildHost() {
  await buildNode('src/index.ts', 'index.js');
  await buildNode('src/control-service.ts', 'control-service.js');
}

async function buildClient() {
  const result = await build({
    entryPoints: [path.join(root, 'src/client/index.tsx')],
    write: false,
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'chrome120',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
    minify: true,
    legalComments: 'none',
    loader: {
      '.css': 'text',
      '.svg': 'dataurl',
      '.png': 'dataurl',
    },
    logLevel: 'info',
  });
  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new Error('Client build produced no output');
  const wrapped = `window.__ModuleLoader__.load({\n  id: '@local/dsh-wireguard',\n  factory(require) {\n    var module = { exports: {} };\n    var exports = module.exports;\n${code
    .split('\n')
    .map((line) => (line.length > 0 ? `    ${line}` : line))
    .join('\n')}\n    return module.exports;\n  },\n});\n`;
  await writeFile(path.join(root, 'client.js'), wrapped, 'utf8');
}

await buildHost();
await buildClient();
console.log('Built index.js and client.js');
