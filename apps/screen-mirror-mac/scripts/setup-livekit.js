const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

try {
  if (process.platform !== 'darwin') throw new Error('此安装脚本仅支持 macOS');
  const prefix = execFileSync('brew', ['--prefix', 'livekit'], { encoding: 'utf8' }).trim();
  const source = path.join(prefix, 'bin', 'livekit-server');
  if (!fs.existsSync(source)) throw new Error('请先运行 brew install livekit，再执行本脚本');
  const version = execFileSync(source, ['--version'], { encoding: 'utf8' }).trim();
  const target = path.join(__dirname, '..', 'resources', 'livekit-server');
  fs.copyFileSync(source, target);
  fs.chmodSync(target, 0o755);
  process.stdout.write(`已复制 ${version} (${process.arch}) 到 ${target}\n`);
} catch (error) {
  process.stderr.write(`LiveKit 安装失败：${error.message}\n先运行 brew install livekit；再运行 npm run setup:livekit\n`);
  process.exitCode = 1;
}
