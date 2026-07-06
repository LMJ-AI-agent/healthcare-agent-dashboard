import { spawn } from 'node:child_process';

await run(process.execPath, ['scripts/build-dashboard.js']);
await run('git', ['add', 'docs']);

const changed = await output('git', ['diff', '--cached', '--quiet'])
  .then(() => false)
  .catch((error) => {
    if (error.code === 1) return true;
    throw error;
  });

if (!changed) {
  console.log('Dashboard is already up to date.');
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10);
await run('git', ['commit', '-m', `Update health dashboard ${stamp}`]);
await run('git', ['push']);
console.log('Dashboard pushed to GitHub.');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else {
        const error = new Error(`${command} ${args.join(' ')} exited with code ${code}`);
        error.code = code;
        reject(error);
      }
    });
  });
}

function output(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else {
        const error = new Error(stderr.trim() || `${command} ${args.join(' ')} exited with code ${code}`);
        error.code = code;
        reject(error);
      }
    });
  });
}
