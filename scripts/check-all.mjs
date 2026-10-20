import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from '../server/services/catalog.mjs';

if (!process.env.npm_execpath) throw new Error('Запускайте через npm run test:all');
const report = { startedAt: new Date().toISOString(), node: process.version, commands: [], passed: false };
try {
  for (const args of [['run', 'build'], ['test'], ['run', 'booking:check'], ['run', 'functional:check'], ['run', 'notifications:check'], ['run', 'admin:check'], ['run', 'privacy:check']]) {
    const started = Date.now();
    console.log(`\nПроверка: npm ${args.join(' ')}`);
    const code = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [process.env.npm_execpath, ...args], { cwd: projectRoot, windowsHide: true, stdio: 'inherit' });
      child.once('error', reject); child.once('close', done);
    });
    report.commands.push({ command: `npm ${args.join(' ')}`, exitCode: code, durationMs: Date.now() - started });
    if (code !== 0) throw new Error(`Проверка npm ${args.join(' ')} завершилась с кодом ${code}`);
  }
  report.passed = true;
} finally {
  report.finishedAt = new Date().toISOString();
  writeFileSync(resolve(projectRoot, 'docs/automated-check.json'), `${JSON.stringify(report, null, 2)}\n`);
}
