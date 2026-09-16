const { execFileSync } = require('child_process');
const path = require('path');

try {
  const executable = path.join(__dirname, '..', 'resources', 'livekit-server');
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
  process.stdout.write(`LiveKit 打包检查通过：${version}`);
} catch (error) {
  process.stderr.write(`不能打包：LiveKit Server 缺失或无法执行。请运行 npm run setup:livekit。\n${error.message}\n`);
  process.exitCode = 1;
}
