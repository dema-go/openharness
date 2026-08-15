import chokidar from 'chokidar';
import path from 'node:path';
import os from 'node:os';
const root = path.join(os.homedir(), '.codex', 'sessions');
const w = chokidar.watch(path.join(root, '**', '*.jsonl'), { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } });
w.on('all', (ev, p) => console.log('EVENT:', ev, p.replace(root, '~')));
w.on('error', (e) => console.log('ERR', e));
console.log('watching', root);
setTimeout(() => { console.log('done test'); process.exit(0); }, 10000);
