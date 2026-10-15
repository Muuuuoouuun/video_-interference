import { spawn } from 'node:child_process';
const children = [
  spawn(process.execPath, ['apps/worker/server.mjs'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts'], { stdio: 'inherit' })
];
let shuttingDown = false;
function stop(code = 0) { if (shuttingDown) return; shuttingDown = true; for (const child of children) child.kill('SIGTERM'); setTimeout(() => process.exit(code), 150).unref(); }
for (const child of children) child.on('exit', code => stop(code ?? 1));
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
