/*
  MC 游戏时长 · 一键安装
  ----------------------
  换了一台电脑、或者把 MC-Timer 文件夹挪了位置之后跑一次就行（双击 一键安装.cmd）。
  它做四件事：
    1. 检查 mc-time.json，问要不要清空重新开始（原数据自动改名备份）
    2. 找到这台电脑上 PCL 的数据目录，写进 pcl-custom-path.txt
       —— server.js 靠它把主页镜像到 PCL 真正读取的 Custom.xaml，
          也靠它读 Setup.ini / LatestLaunch.bat 认出这次玩的是哪个整合包
    3. 把 PCL主页.xaml 里「一键启动服务」按钮写死的路径改成本机路径
    4. 启动一次时长服务，让 PCL 主页立刻生效

  用法：node install.js         正常安装
        node install.js --dry   只打印检测结果，不改任何文件、不起服务
*/
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const readline = require('readline');
const { spawn } = require('child_process');

const DIR         = __dirname;
const DATA        = path.join(DIR, 'mc-time.json');
const HOME        = path.join(DIR, 'PCL主页.xaml');
const STARTER     = path.join(DIR, 'start-hidden.vbs');
const PANEL       = path.join(DIR, '我的游戏时长.html');
const SERVER      = path.join(DIR, 'server.js');
const CUSTOM_PTR  = path.join(DIR, 'pcl-custom-path.txt');
const PORT        = 8137;
const DRY         = process.argv.indexOf('--dry') >= 0;

// ---------- 输出 ----------
const say = s => console.log(s);
function title(s) { say(''); say('  ' + s); say('  ' + '-'.repeat(46)); }
function step(n, s) { say(''); say('  [' + n + '] ' + s); }

// ---------- 交互 ----------
let rl = null;
function ask(q, def) {
  if (DRY || !process.stdin.isTTY) return Promise.resolve(def || '');
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question('  ' + q, a => res(String(a).trim())));
}
async function askYesNo(q, defYes) {
  const hint = defYes ? ' [Y/n] ' : ' [y/N] ';
  const a = (await ask(q + hint)).toLowerCase();
  if (!a) return !!defYes;
  return a === 'y' || a === 'yes';
}

// ---------- 1. 数据文件 ----------
function modCount() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    return Array.isArray(d.mods) ? d.mods.length : 0;
  } catch (e) { return 0; }
}
function stamp() {
  const d = new Date(), p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}
async function handleData() {
  step(1, '检查时长数据');
  const n = modCount();
  if (!fs.existsSync(DATA)) { say('     没有 mc-time.json，服务会自动新建一份空数据。'); return; }
  if (!n) { say('     mc-time.json 里没有记录，无需处理。'); return; }
  say('     mc-time.json 里有 ' + n + ' 条记录（可能是上一个人的游玩时长）。');
  const yes = await askYesNo('     是否清空、从 0 开始记录你自己的时长？', false);
  if (!yes) { say('     保留现有数据。'); return; }
  const bak = path.join(DIR, 'mc-time.旧数据-' + stamp() + '.json');
  if (DRY) { say('     [dry] 会备份为 ' + path.basename(bak) + '，然后清空'); return; }
  fs.renameSync(DATA, bak);
  say('     已备份为 ' + path.basename(bak) + '，并清空。');
}

// ---------- 2. 找 PCL 数据目录 ----------
// PCL2 的数据目录规则：<启动器所在目录>\PCL\（里面的 Setup.ini / LatestLaunch.bat 是判据）
function looksLikePclDir(d) {
  try {
    return fs.existsSync(path.join(d, 'Setup.ini')) || fs.existsSync(path.join(d, 'LatestLaunch.bat'));
  } catch (e) { return false; }
}
function dataDirFromExeDir(exeDir) {
  const sub = path.join(exeDir, 'PCL');
  if (looksLikePclDir(sub)) return sub;
  if (looksLikePclDir(exeDir)) return exeDir;          // 便携版：Setup.ini 直接在 exe 旁边
  if (fs.existsSync(sub)) return sub;                   // PCL 还没跑过，但目录已经是那个结构
  return null;
}
function desktopCandidates() {
  const up = process.env.USERPROFILE || os.homedir();
  const out = [path.join(up, 'Desktop', 'PCL')];
  const ods = [process.env.OneDrive, path.join(up, 'OneDrive')].filter(Boolean);
  ods.forEach(o => out.push(path.join(o, 'Desktop', 'PCL')));
  if (process.env.PUBLIC) out.push(path.join(process.env.PUBLIC, 'Desktop', 'PCL'));
  return out;
}
const EXE_NAMES = ['pcl.exe', 'pcl2.exe', 'plain craft launcher 2.exe'];
const SKIP_DIRS = ['windows', '$recycle.bin', 'system volume information', 'programdata',
  'recovery', 'perflogs', 'appdata', 'node_modules', '.git', 'msocache', 'temp', 'tmp',
  'intel', 'amd', 'nvidia', 'drivers', 'assembly'];
function scanForExeDirs() {
  const roots = [];
  const up = process.env.USERPROFILE || '';
  [path.join(up, 'Desktop'), path.join(up, 'Downloads'),
   process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
   process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter(Boolean).forEach(d => roots.push(d));
  'CDEFGHIJ'.split('').forEach(L => {
    const r = L + ':\\';
    try { if (fs.existsSync(r)) roots.push(r); } catch (e) {}
  });

  const found = [];
  const budget = { n: 12000 };
  function walk(dir, depth) {
    if (depth < 0 || budget.n <= 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    budget.n--;
    for (const en of entries) {
      const full = path.join(dir, en.name);
      if (en.isSymbolicLink()) continue;
      if (en.isFile()) {
        if (EXE_NAMES.indexOf(en.name.toLowerCase()) >= 0) found.push(dir);
      } else if (en.isDirectory() && depth > 0) {
        if (SKIP_DIRS.indexOf(en.name.toLowerCase()) >= 0) continue;
        walk(full, depth - 1);
      }
    }
  }
  roots.forEach(r => walk(r, 2));
  return found.filter((v, i, a) => a.indexOf(v) === i);
}
function readPtr() {
  try {
    const t = fs.readFileSync(CUSTOM_PTR, 'utf8').trim().split(/\r?\n/)[0].trim();
    if (t && fs.existsSync(path.dirname(path.resolve(t)))) return path.resolve(t);
  } catch (e) {}
  return null;
}
// PCL 每次启动都会重写 Setup.ini / LatestLaunch.bat，所以「文件最新」的那个目录才是真正在用的。
function pclFreshness(d) {
  let t = 0;
  ['Setup.ini', 'LatestLaunch.bat'].forEach(f => {
    try { t = Math.max(t, fs.statSync(path.join(d, f)).mtimeMs); } catch (e) {}
  });
  return t;
}
async function findPclDir() {
  step(2, '寻找这台电脑上的 PCL 数据目录');

  const fromPtr = readPtr();
  if (fromPtr) {
    say('     沿用已有设置：' + path.dirname(fromPtr));
    return path.dirname(fromPtr);
  }

  // 一台电脑上常留着好几个 PCL 副本（换过位置、装过两次），所以全收进来再挑最近的，
  // 不能见到第一个就用 —— 旧副本一样有 Setup.ini，用错了主页数字永远不会更新。
  const found = [];
  const add = d => { if (d && found.indexOf(d) < 0) found.push(d); };
  desktopCandidates().forEach(d => { if (looksLikePclDir(d)) add(d); });
  scanForExeDirs().forEach(e => add(dataDirFromExeDir(e)));

  if (found.length) {
    found.sort((a, b) => pclFreshness(b) - pclFreshness(a));
    if (found.length === 1) say('     找到：' + found[0]);
    else {
      say('     找到 ' + found.length + ' 个疑似目录，按「最近用过」挑：');
      found.forEach((d, i) => say('       ' + (i ? '忽略 ' : '使用 ') + d));
    }
    return found[0];
  }

  say('');
  say('     ⚠ 没能自动找到 PCL 的数据目录。');
  say('       手动找法：打开 PCL → 设置 → 个性化 → 自定义主页，');
  say('       看「本地主页」用的 Custom.xaml 在哪个文件夹，把那个文件夹路径贴进来。');
  say('       （直接回车则跳过，之后 PCL 主页的时长不会自动更新）');
  const ans = await ask('     请粘贴 PCL 数据目录的完整路径：');
  if (!ans) { say('     已跳过。'); return null; }
  let d = ans.replace(/^"|"$/g, '').trim();
  if (/\.xaml$/i.test(d)) d = path.dirname(d);
  if (!fs.existsSync(d)) { say('     ⚠ 这个路径不存在：' + d + '，跳过。'); return null; }
  return d;
}
function writePtr(pclDir) {
  const target = path.join(pclDir, 'Custom.xaml');
  if (DRY) { say('     [dry] 会写入 pcl-custom-path.txt → ' + target); return target; }
  fs.writeFileSync(CUSTOM_PTR, target + '\r\n', 'utf8');
  say('     已写入 pcl-custom-path.txt → ' + target);
  return target;
}

// ---------- 3. 改 PCL主页.xaml ----------
function xmlEsc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function patchHomepage(name) {
  if (!fs.existsSync(HOME)) { say('     ⚠ 没找到 PCL主页.xaml，跳过。'); return; }
  let t = fs.readFileSync(HOME, 'utf8');
  const before = t;

  // 按钮路径：把别人电脑上那份写死的 EventData 换成这台电脑上的实际路径
  t = t.replace(/(Text="一键启动服务"\s+EventType="打开文件"\s+EventData=")[^"]*(")/,
    (m, a, b) => a + xmlEsc(STARTER) + b);
  // 欢迎语：把上一个人的昵称换掉
  t = t.replace(/Text="欢迎回来[^"]*"/, 'Text="欢迎回来' + (name ? '，' + xmlEsc(name) : '') + '！"');

  if (DRY) {
    say('     [dry] 会写入：' + STARTER);
    say('     [dry] 欢迎语会变成：' + (name ? '欢迎回来，' + name + '！' : '欢迎回来！'));
    return;
  }
  if (t !== before) { fs.writeFileSync(HOME, t, 'utf8'); say('     已更新 PCL主页.xaml。'); }
  else say('     PCL主页.xaml 无需改动。');
}

// ---------- 4. 起服务 ----------
function portBusy() {
  return new Promise(res => {
    const s = net.connect({ port: PORT, host: '127.0.0.1' });
    const done = v => { try { s.destroy(); } catch (e) {} res(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(800, () => done(false));
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function startService() {
  step(4, '启动时长服务');
  if (await portBusy()) { say('     服务已经在跑了（端口 ' + PORT + '）。'); return true; }
  if (DRY) { say('     [dry] 会启动 node server.js'); return true; }
  const log = path.join(DIR, 'server.log');
  const out = fs.openSync(log, 'a');
  const p = spawn(process.execPath, ['server.js'], { cwd: DIR, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  p.unref();
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (await portBusy()) { say('     服务已启动（端口 ' + PORT + '）。'); return true; }
  }
  say('     ⚠ 服务好像没起来，看看 server.log 里写了什么：' + log);
  return false;
}

// ---------- 主流程 ----------
(async function main() {
  title('MC 游戏时长 · 一键安装' + (DRY ? '（--dry 试运行，不会改任何文件）' : ''));
  say('  安装位置：' + DIR);

  if (!fs.existsSync(SERVER) || !fs.existsSync(PANEL)) {
    say('');
    say('  ✗ 这个文件夹里没找到 server.js / 我的游戏时长.html。');
    say('    请把 一键安装.cmd 和 install.js 放在 MC-Timer 文件夹里再运行。');
    process.exitCode = 1;
    return;
  }

  await handleData();

  const pclDir = await findPclDir();
  if (pclDir) writePtr(pclDir);

  step(3, '修改 PCL 主页里的按钮路径');
  const name = await ask('     你的游戏昵称（用于主页欢迎语，直接回车用默认）：');
  patchHomepage(name);

  await startService();

  title('完成');
  say('  接下来在 PCL 里做一次：');
  say('    设置 → 个性化 → 自定义主页 → 选「本地主页」');
  say('    （时长卡片的内容会自动写进 PCL 读取的 Custom.xaml）');
  say('');
  say('  以后想计时，就在 PCL 主页「游戏时长」卡片点【一键启动服务】。');
  say('  面板地址：http://127.0.0.1:' + PORT + '/');
  say('  挪过文件夹或按钮报错时，重新双击一次 一键安装.cmd 就行。');
  say('');
  if (rl) rl.close();
})().catch(e => {
  say('');
  say('  ✗ 出错了：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
