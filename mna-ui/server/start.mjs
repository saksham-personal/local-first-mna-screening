import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from './bridge.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridge = await startBridge();
const preview = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), process.argv.includes('--dev') ? '--host' : 'preview', ...(process.argv.includes('--dev') ? ['127.0.0.1','--port','5173','--strictPort'] : ['--host','127.0.0.1','--port','4173','--strictPort'])], { cwd: root, windowsHide: true, stdio: 'inherit' });
const close = () => { preview.kill(); bridge.close(); };
process.on('SIGINT', () => { close(); process.exit(0); });
process.on('SIGTERM', () => { close(); process.exit(0); });
preview.on('exit', code => { bridge.close(); process.exit(code ?? 0); });
console.log('Screening workspace ready. External execution is disabled unless explicitly configured.');
