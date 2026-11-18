// Runs `ng build` and exits as soon as the bundle is finished.
// With this Angular/esbuild version the CLI process can stay alive after a completed build
// (seen on Windows and Linux), which hangs CI. We watch the output, then end the process tree.
// usage: node scripts/build.mjs [extra ng build args]
import { spawn, execFileSync } from 'node:child_process';

const isWin = process.platform === 'win32';
const args = ['ng', 'build', ...process.argv.slice(2)];
const child = spawn(isWin ? 'npx.cmd' : 'npx', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: !isWin, // own process group on Linux/macOS, so the whole tree can be ended
  shell: isWin,
});

let output = '';
let result = null; // 0 = success, 1 = failure, decided from the output
const onData = (stream) => (chunk) => {
  const text = chunk.toString();
  stream.write(text);
  output += text;
  if (result !== null) return;
  if (/Application bundle generation failed|\[ERROR\]|✘/.test(output)) result = 1;
  else if (/Application bundle generation complete/.test(output)) result = 0;
  if (result !== null) setTimeout(finish, 2000); // let the CLI finish writing files and the summary
};
child.stdout.on('data', onData(process.stdout));
child.stderr.on('data', onData(process.stderr));

function killTree() {
  if (child.exitCode !== null) return;
  try {
    if (isWin) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

function finish() {
  killTree();
  process.exit(result ?? 1);
}

child.on('exit', (code) => {
  if (result === null) process.exit(code ?? 1);
});

// Safety net: never hang longer than 10 minutes.
setTimeout(() => {
  console.error('ng build did not finish within 10 minutes');
  result = 1;
  finish();
}, 10 * 60 * 1000).unref();
