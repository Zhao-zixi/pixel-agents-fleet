import fs from 'node:fs';
import path from 'node:path';

const output = path.resolve(process.argv[2], 'THIRD-PARTY-LICENSES');
fs.mkdirSync(output, { recursive: true });
function scanModules(modules, prefix = '') {
  if (!fs.existsSync(modules)) return;
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const folder = path.join(modules, entry.name);
    if (entry.name.startsWith('@')) {
      scanModules(folder, `${prefix}${entry.name}/`);
      continue;
    }
    const name = `${prefix}${entry.name}`;
    for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
      if (file.isFile() && /^(licen[cs]e|copying|notice|authors)(\.|$)/i.test(file.name)) {
        const target = path.join(output, name.replaceAll('/', '__'));
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(path.join(folder, file.name), path.join(target, file.name));
      }
    }
    scanModules(path.join(folder, 'node_modules'), `${name}/`);
  }
}
scanModules(path.resolve('node_modules'));
scanModules(path.resolve('webview-ui/node_modules'), 'webview/');
console.log('Collected installed dependency licenses (including bundled frontend and fonts).');
