/*
  MC 游戏时长 · 本地服务
  ----------------------
  功能：
    1. 保存计时数据到 mc-time.json
    2. 实时把最新的「游戏时长」卡片写进 PCL主页.xaml，
       并镜像到 PCL 真正读取的 桌面\PCL\Custom.xaml
       （PCL 本地主页模式固定读它自己目录里的 Custom.xaml；切回主页就见到新数字）
    3. 提供计时面板页面 http://127.0.0.1:8137/
       （纯本机：可自定义网页背景 / 自动列出整合包并显示各包时长 /
         浏览整合包文件夹的模组清单与存档统计历史）
    4. 后台每 5 秒检测 Minecraft(javaw) 是否在运行：自动开始 / 自动结束计时
    5. 自动计时会自动分辨“正在玩哪个整合包”：读 PCL 每次启动都重写的
       LatestLaunch.bat（GBK/UTF-8 兼容），按 记录.folder 路径精确对应，其次按同名；
       分辨不出时才记到你在自动计时里选的兜底包。面板与主页会显示当前在玩哪包。
    6. 读整合包各世界存档 stats/*.json 的 play_time（tick/20）作为历史时长，
       供面板展示；也可在「＋ 记时长」时作为起始累计并入计时记录。

  启动方式（不开机自启）：
    · 正常：在 PCL 主页的「游戏时长」卡片里点「一键启动服务」即可（后台静默运行）
    · 调试：也可以双击 启动计时服务.cmd（会弹黑色窗口，关闭即停）
  停止：在计时面板最下面点「关闭服务」，或任务管理器结束 node.exe
*/
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DIR   = __dirname;
const DATA  = path.join(DIR, 'mc-time.json');
const PANEL = path.join(DIR, '我的游戏时长.html');
const HOME  = path.join(DIR, 'PCL主页.xaml');
const STARTER = path.join(DIR, 'start-hidden.vbs');
const PORT  = 8137;

// PCL 本地主页模式固定读取它自己数据目录里的 Custom.xaml（桌面版是 桌面\PCL\Custom.xaml）。
// 想把镜像写到别处：在本文件同目录放一个 pcl-custom-path.txt，第一行写目标文件的完整路径即可。
// 默认按「当前用户」算，不写死用户名：换了台电脑/换个用户名也能对上。
const PCL_CUSTOM_DEFAULT = path.join(process.env.USERPROFILE || require('os').homedir(), 'Desktop', 'PCL', 'Custom.xaml');
const PCL_CUSTOM = (function () {
  try {
    const o = path.join(DIR, 'pcl-custom-path.txt');
    if (fs.existsSync(o)) {
      const t = fs.readFileSync(o, 'utf8').trim();
      if (t) return path.resolve(t);
    }
  } catch (e) {}
  return PCL_CUSTOM_DEFAULT;
})();
const HOST  = '127.0.0.1';
const BASE   = 'http://127.0.0.1:' + PORT;

// ---------- 工具 ----------
const now = () => Math.floor(Date.now() / 1000);
const pad = n => (n < 10 ? '0' : '') + n;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayKey(ts) {
  const d = new Date(ts * 1000);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
// 清洗「日期 -> 值」的映射：只留合法日期键；isNote=true 保留文本备注，否则保留正数秒
function cleanDayMap(obj, isNote) {
  const out = {};
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    Object.keys(obj).forEach(k => {
      if (!DATE_RE.test(k)) return;
      if (isNote) {
        const s = String(obj[k] == null ? '' : obj[k]).trim().slice(0, 500);
        if (s) out[k] = s;
      } else {
        const n = Math.floor(Number(obj[k]) || 0);
        if (n > 0) out[k] = n;
      }
    });
  }
  return out;
}
function fmtHuman(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  if (m > 0) return m + ' 分 ' + ss + ' 秒';
  return ss + ' 秒';
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
let _c = 100;
const rnd = () => 'm' + Date.now() + '_' + (++_c);

// ---------- 数据 ----------
function seed() {
  return {
    mods: [
      { id: rnd(), name: '我的整合包', total: 0, start: null, autoStarted: false },
      { id: rnd(), name: '其它世界', total: 0, start: null, autoStarted: false }
    ],
    days: {},
    notes: {},
    seg: {},
    auto: { enabled: false, packId: null },
    ui: { bg: null, dim: 50, lastPack: '', order: [], forder: [], ink: '#eef2f7', accent: '#44c7d6', glass: 50, icons: 'emoji' },
    folders: [],   // 文件夹分组（标签式整理，不影响总累计）：[{name, keys:[…]}]
    excl: []   // 不计入总榜的主榜行：'r:<记录id>' 或 'p:<文件夹小写路径>'
  };
}
function normalize(o) {
  if (!o || typeof o !== 'object') o = {};
  o.mods = (Array.isArray(o.mods) ? o.mods : []).map(m => {
    const r = {
      id: String(m.id || rnd()),
      name: String(m.name || '未命名'),
      total: Math.max(0, Number(m.total) || 0),
      start: m.start ? Number(m.start) : null,
      autoStarted: !!(m.autoStarted)
    };
    // 可选：记录和整合包实例文件夹的对应（自动分辨“在玩哪包”时优先用它精确匹配）
    if (m.folder && typeof m.folder === 'string' && m.folder.trim()) r.folder = m.folder.trim().slice(0, 300);
    return r;
  });
  if (!o.mods.length) o.mods = [{ id: rnd(), name: '我的整合包', total: 0, start: null, autoStarted: false }];
  o.days = cleanDayMap(o.days, false);
  o.notes = cleanDayMap(o.notes, true);
  // seg：精确“时间段”档案（date -> [{s,e,pack}]，s/e 为 epoch 秒），跨天已切开
  const rawSeg = (o.seg && typeof o.seg === 'object' && !Array.isArray(o.seg)) ? o.seg : {};
  o.seg = {};
  Object.keys(rawSeg).forEach(k => {
    if (!DATE_RE.test(k) || !Array.isArray(rawSeg[k])) return;
    const arr = [];
    rawSeg[k].forEach(g => {
      if (!g || typeof g !== 'object') return;
      const s = Math.floor(Number(g.s)), e = Math.floor(Number(g.e));
      if (isFinite(s) && isFinite(e) && e > s && (e - s) < 86400 * 400) arr.push({ s, e, pack: String(g.pack || '').slice(0, 80) });
    });
    if (arr.length) o.seg[k] = arr.slice(-4000);
  });
  o.auto = o.auto || { enabled: false, packId: null };
  if (!o.mods.some(m => m.id === o.auto.packId)) o.auto.packId = null;
  // 面板偏好（背景图 / 压暗 / 上次读的整合包路径），跟着 mc-time.json 一起存
  if (!o.ui || typeof o.ui !== 'object' || Array.isArray(o.ui)) o.ui = {};
  if (typeof o.ui.bg !== 'string' || !/^panel-bg\.(png|jpg|gif|webp)$/.test(o.ui.bg)) o.ui.bg = null;
  const _dim = Math.floor(Number(o.ui.dim));
  o.ui.dim = (!isNaN(_dim) ? Math.min(85, Math.max(0, _dim)) : 50);
  if (typeof o.ui.lastPack !== 'string') o.ui.lastPack = '';
  // 不计入总榜的 key 白名单：'r:<记录id>' / 'p:<文件夹路径>'
  if (!Array.isArray(o.excl)) o.excl = [];
  o.excl = o.excl.filter(k => typeof k === 'string' && k.length > 2 && (k.startsWith('r:') || k.startsWith('p:'))).slice(0, 2000);
  o.excl = Array.from(new Set(o.excl));
  // 自定义排序顺序（仅面板用）：'r:<记录id>' / 'p:<文件夹路径>'，最多 3000 条
  if (!Array.isArray(o.ui.order)) o.ui.order = [];
  o.ui.order = Array.from(new Set(o.ui.order.filter(k => typeof k === 'string' && k.length > 2 && (k.startsWith('r:') || k.startsWith('p:'))))).slice(0, 3000);
  // 个性化：文字颜色 / 强调色 / 毛玻璃透明度 / 图标样式
  if (typeof o.ui.ink !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(o.ui.ink)) o.ui.ink = '#eef2f7'; else o.ui.ink = o.ui.ink.toLowerCase();
  if (typeof o.ui.accent !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(o.ui.accent)) o.ui.accent = '#44c7d6'; else o.ui.accent = o.ui.accent.toLowerCase();
  const _g = Math.floor(Number(o.ui.glass));
  o.ui.glass = isNaN(_g) ? 50 : Math.min(100, Math.max(0, _g));
  if (o.ui.icons !== 'plain' && o.ui.icons !== 'emoji') o.ui.icons = 'emoji';
  // 文件夹分组：标签式整理（一个包可同时出现在多个文件夹里），不影响任何时长
  const _seenF = {};
  const _folders = [];
  (Array.isArray(o.folders) ? o.folders : []).forEach(f => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return;
    const nm = String(f.name || '').trim().slice(0, 24);
    if (!nm) return;
    const low = nm.toLowerCase();
    if (_seenF[low]) return;
    _seenF[low] = 1;
    const keys = Array.from(new Set((Array.isArray(f.keys) ? f.keys : []).filter(k => typeof k === 'string' && k.length > 2 && (k.startsWith('r:') || k.startsWith('p:')))));
    _folders.push({ name: nm, keys: keys.slice(0, 2000) });
  });
  o.folders = _folders.slice(0, 80);
  // 文件夹自定义排序顺序（仅面板用）：文件夹名列表，已删除/不存在的名字自动清掉，新文件夹排后面
  if (!Array.isArray(o.ui.forder)) o.ui.forder = [];
  const _fnames = {};
  o.folders.forEach(f => { _fnames[f.name] = 1; });
  o.ui.forder = Array.from(new Set(o.ui.forder.filter(n => typeof n === 'string' && _fnames[n]))).slice(0, 200);
  return o;
}
function load() {
  try { return normalize(JSON.parse(fs.readFileSync(DATA, 'utf8'))); }
  catch (e) { return seed(); }
}
let db = load();
function save() {
  const store = JSON.parse(JSON.stringify(db));
  delete store.running;
  try { fs.writeFileSync(DATA, JSON.stringify(store, null, 2), 'utf8'); }
  catch (e) { console.log('[save error]', e.message); }
  writeHomepage();   // 数据一变，同步刷新 PCL 本地主页文件
}
function find(id) { return db.mods.find(m => m.id === id) || null; }
function activeSeconds(m) { return m && m.start ? Math.max(0, now() - m.start) : 0; }
function totalOf(m) { return (m ? (Number(m.total) || 0) + activeSeconds(m) : 0); }
// 一条记录是否被设为「不计入总榜」（主榜/主页的总累计都跳过它）
function isRecExcluded(id) { return id != null && (db.excl || []).includes('r:' + id); }
function grandTotal() { return db.mods.reduce((s, m) => s + (isRecExcluded(m.id) ? 0 : totalOf(m)), 0); }
function finalize(m) {
  if (!m || !m.start) return 0;
  const s0 = m.start, e0 = now();
  const el = e0 - s0;
  m.total = Math.max(0, (Number(m.total) || 0) + el);
  const k = dayKey(e0);
  db.days[k] = (db.days[k] || 0) + el;
  // 精确“时间段”入档（跨天就按天切开），日历当天可以列出来
  let cur = s0;
  while (cur < e0) {
    const d = new Date(cur * 1000);
    const nextDay = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() / 1000);
    const st = Math.min(e0, nextDay);
    const dk = dayKey(cur);
    db.seg[dk] = db.seg[dk] || [];
    if (db.seg[dk].length < 4000) db.seg[dk].push({ s: cur, e: st, pack: String(m.name || '').slice(0, 80) });
    cur = st;
  }
  m.start = null;
  m.autoStarted = false;
  return el;
}
function stateOut() {
  return JSON.parse(JSON.stringify(Object.assign({}, db, { running: mcRunningFlag, runningPack: mcRunningFlag ? lastDetectedName : '' })));
}

// ---------- 自动计时（检测 javaw 窗口 + 分辨当前在玩哪个整合包） ----------
let mcRunningFlag = false;
let checking = false;
let prevRunning = false;      // 上一次检测结果：用来抓「进游戏 / 退游戏」的边沿
let activeAutoId = null;      // 本次自动计时实际记到哪条记录（可能是自动分辨出来的那包）
let lastDetectedName = '';    // 当前在玩的整合包名（供面板 / 主页显示）
function mcRunning(cb) {
  // 游戏可能以 javaw.exe 或 java.exe 启动；用「有可见窗口」判断，比只看标题更稳。
  // 注意：不能写 Get-Process javaw,java —— 当其中某个进程名不存在时 PowerShell 会报一个
  // 被 -EA SilentlyContinue 吞掉、却把进程退出码置成 1 的错误，会让 execFile 的 err 非空、
  // 被下面的旧逻辑误判成「没在玩」。所以枚举全部进程、在管道里按进程名过滤，命令稳定以 0 退出。
  const ps = `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'java' -or $_.ProcessName -eq 'javaw' } | Where-Object { $_.MainWindowHandle -ne 0 -or $_.MainWindowTitle } | Measure-Object | Select-Object -ExpandProperty Count`;
  execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
    // 以 stdout 解析出的数字为准：解析得出就用它，避免无害的非零退出码造成误判
    const n = parseInt((stdout || '').trim(), 10);
    if (!isNaN(n)) { cb(n > 0); return; }
    cb(false);
  });
}
function tick() {
  if (checking) return;
  checking = true;
  mcRunning(running => {
    mcRunningFlag = running;
    try {
      if (db.auto && db.auto.enabled) {
        const fallback = find(db.auto.packId);
        if (running && !prevRunning) {           // ── 上升沿：刚进游戏
          // 已经有人在手动计时就不抢，尊重手动
          const anyManual = db.mods.some(m => m.start && !m.autoStarted);
          if (!anyManual) {
            const det = detectRunningPack();      // 分辨正在玩哪个整合包（可能读不到 = null）
            lastDetectedName = det ? det.name : '';
            // 分出来了：用对应记录；没有记录就自动新建一条。分辨不出：退回自动计时里选的兜底包。
            const target = det ? autoEnsureRecord(det) : fallback;
            if (target && !target.start) {
              target.start = now();
              target.autoStarted = true;
              activeAutoId = target.id;
              save();
              console.log('[auto] start ->', target.name, det ? '(detected ' + det.name + ')' : '(fallback ' + (fallback ? fallback.name : '?') + ')');
            }
          }
        } else if (!running && prevRunning) {    // ── 下降沿：退出游戏
          let done = false;
          if (activeAutoId) {
            const a = find(activeAutoId);
            if (a && a.start && a.autoStarted) { finalize(a); done = true; console.log('[auto] stop', a.name); }
          }
          if (!done && fallback && fallback.start && fallback.autoStarted) { finalize(fallback); done = true; console.log('[auto] stop', fallback.name); }
          if (done) save();
          activeAutoId = null;
        }
        if (!running) lastDetectedName = '';
      } else {
        activeAutoId = null;
        if (!running) lastDetectedName = '';
      }
      prevRunning = running;
    } catch (e) { console.log('[tick error]', e.message); }
    checking = false;
    writeHomepage();   // 自动计时状态变了也同步到主页文件（内容没变会自动跳过）
  });
}
setInterval(tick, 5000);

// ---------- 生成主页卡片（XAML） ----------
function buildCard() {
  const L = [];
  const activeNames = [];
  db.mods.forEach(m => { if (m.start) activeNames.push(m.name); });

  // 卡片要落在上排两列 Grid 的左格 (0,0)：行列号跟 PCL主页.xaml 里的占位必须一致。
  // 若以后把这张卡挪去别的格，改下面这行 Grid.Row/Grid.Column 和 Margin 即可。
  // （下方间距由外围 <Grid Margin="0,0,0,15"> 统一负责，这里左右留 8 与右邻卡片隔开）
  L.push('<!-- ===== 以下为本地服务实时生成的「游戏时长」卡片，请勿手改 ===== -->');
  L.push('<local:MyCard Grid.Column="0" Grid.Row="0" Title="游戏时长" Margin="0,0,8,0">');
  L.push('    <StackPanel Margin="25,40,23,15">');
  L.push('        <TextBlock FontSize="22" FontWeight="Bold" HorizontalAlignment="Center"');
  L.push('                   Foreground="{DynamicResource ColorBrush1}" Text="总累计：' + esc(fmtHuman(grandTotal())) + '" />');
  if (db.mods.length) {
    L.push('        <StackPanel Margin="14,10,14,0">');
    db.mods.forEach(m => {
      // 被设为「不计入总榜」的记录：主页照常列出（灰色 + 注明），只是不计入上面的总累计
      const off = isRecExcluded(m.id);
      L.push('            <TextBlock FontSize="14" HorizontalAlignment="Center" Margin="0,3,0,3"'
        + (off ? ' Foreground="{DynamicResource ColorBrush3}"' : '')
        + ' Text="' + esc(m.name) + '：' + esc(fmtHuman(totalOf(m))) + (off ? '（不计入总榜）' : '') + '" />');
    });
    L.push('        </StackPanel>');
  }
  const noteParts = [];
  if (mcRunningFlag) noteParts.push('自动计时运行中' + (lastDetectedName ? '：' + lastDetectedName : ''));
  else if (db.auto && db.auto.enabled) noteParts.push('自动计时已开启，等待进游戏');
  if (activeNames.length) noteParts.push('手动计时中：' + activeNames.join('、'));
  const note = noteParts.length ? noteParts.join('　·　') : '点下方按钮可启动服务 / 管理时长';
  L.push('        <TextBlock FontSize="11" Foreground="{DynamicResource ColorBrush4}" HorizontalAlignment="Center" Margin="0,12,0,0"');
  L.push('                   TextWrapping="Wrap" Text="' + esc(note) + '" />');
  // 一键启动后台服务（不开机自启：需要服务时在主页里点一下即可）
  L.push('        <local:MyButton Margin="0,14,0,0" Height="35" HorizontalAlignment="Center" Padding="20,0,20,0"');
  L.push('                        Text="一键启动服务" EventType="打开文件" EventData="' + esc(STARTER) + '"');
  L.push('                        ToolTip="后台静默启动时长服务，不用自己打开 cmd。若已在运行则无影响" />');
  // 打开计时面板的直达按钮（与计时器同一板块）
  L.push('        <local:MyButton Margin="0,8,0,0" Height="35" HorizontalAlignment="Center" Padding="20,0,20,0"');
  L.push('                        Text="打开手动计时面板" EventType="打开网页" EventData="' + BASE + '/"');
  L.push('                        ToolTip="打开计时面板：可手动开始/结束、加减时长、管理整合包" />');
  L.push('    </StackPanel>');
  L.push('</local:MyCard>');
  return L.join('\n');
}
// ---------- 每日运势 / 每日一言（以当天日期为种子，跨天自动换，同一天内固定） ----------
const LUCK_LEVELS = ['大凶', '小凶', '平平', '小吉', '中吉', '大吉'];
const LUCK_YI = ['挖矿', '下矿找钻石', '种田', '钓鱼', '盖房子', '驯一匹马', '去末地', '开宝箱'];
const LUCK_JI = ['在岩浆里洗澡', '用 TNT 炸自家', '徒手撸苦力怕', '大半夜下矿', '惹恼村民', '拆末影水晶', '空腹去打龙', '掉进虚空'];
const QUOTES = [
  '钻石藏得再深，也怕一把铁镐一直挖。',
  '别怕重来——存档还在，人就还赢。',
  '最美的风景，常在没走过的那条路上。',
  '耐心挖下去，总会有闪光的时候。',
  '世界很大，先从手边的泥土开始。',
  '今天也把日子过成一张新地图，去探索就好。'
];
// 按种子错位取两个不重复的词（跨天稳定、同天不变）
function pickTwo(arr, s) {
  const n = arr.length;
  let a = arr[s % n];
  let b = arr[(s + 3 + ((s >>> 2) % n)) % n];
  if (b === a) b = arr[(s + 1) % n];
  return [a, b];
}
function buildDaily() {
  const d = dayKey(now());                     // 'YYYY-MM-DD'
  let seed = 0;
  for (const ch of d) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;  // 稳定的小哈希
  const lv  = LUCK_LEVELS[seed % LUCK_LEVELS.length];
  const yi2 = pickTwo(LUCK_YI, seed >>> 3);
  const ji2 = pickTwo(LUCK_JI, seed >>> 5);
  const q   = QUOTES[(seed >>> 7) % QUOTES.length];
  // 大字定级：吉/凶/平 + 对应主题色
  let glyph = '吉', brush = 'ColorBrush1';
  if (lv.indexOf('凶') >= 0) { glyph = '凶'; brush = 'ColorBrush4'; }
  else if (lv === '平平')    { glyph = '平'; brush = 'ColorBrush3'; }
  const L = [];
  L.push('<TextBlock FontSize="42" FontWeight="Bold" Foreground="{DynamicResource ' + brush + '}" HorizontalAlignment="Center" Text="' + glyph + '" />');
  L.push('<TextBlock FontSize="14" FontWeight="Bold" HorizontalAlignment="Center" Margin="0,2,0,0" Text="今日运势 ' + esc(lv) + '" />');
  L.push('<Grid Margin="0,12,0,0">');
  L.push('    <Grid.ColumnDefinitions><ColumnDefinition Width="*" /><ColumnDefinition Width="*" /></Grid.ColumnDefinitions>');
  L.push('    <StackPanel Grid.Column="0" HorizontalAlignment="Center">');
  L.push('        <TextBlock Text="宜" FontSize="16" FontWeight="Bold" HorizontalAlignment="Center" Foreground="{DynamicResource ColorBrush3}" Margin="0,0,0,6" />');
  yi2.forEach(t => L.push('        <TextBlock FontSize="13" HorizontalAlignment="Center" Margin="0,2,0,2" Text="' + esc(t) + '" />'));
  L.push('    </StackPanel>');
  L.push('    <StackPanel Grid.Column="1" HorizontalAlignment="Center">');
  L.push('        <TextBlock Text="忌" FontSize="16" FontWeight="Bold" HorizontalAlignment="Center" Foreground="{DynamicResource ColorBrush4}" Margin="0,0,0,6" />');
  ji2.forEach(t => L.push('        <TextBlock FontSize="13" HorizontalAlignment="Center" Margin="0,2,0,2" Text="' + esc(t) + '" />'));
  L.push('    </StackPanel>');
  L.push('</Grid>');
  L.push('<TextBlock FontSize="12" Foreground="{DynamicResource ColorBrush4}" HorizontalAlignment="Center" Margin="0,12,0,0" TextWrapping="Wrap"');
  L.push('           Text="「' + esc(q) + '」" />');
  return L.join('\n');
}
function buildHomepage() {
  const card = buildCard();
  const daily = buildDaily();
  let out = '';
  try { if (fs.existsSync(HOME)) out = fs.readFileSync(HOME, 'utf8'); } catch (e) { out = ''; }

  // ① 每日板块：替换「我的寄语」卡里 开始标记 → 结束标记 之间的内容（含两个标记本身）。
  //    每天第一次计时/启动服务时内容随日期变一次，之后保持不变直到跨天。
  const DAILY_START = '<!-- ==================== 今日运势 · 每日一言 ==================== -->';
  const DAILY_END   = '<!-- ===== 以上为自动生成，请勿手改 ===== -->';
  const reDaily = /<!-- ==================== 今日运势 · 每日一言 ==================== -->[\s\S]*?<!-- ===== 以上为自动生成，请勿手改 ===== -->/;
  if (reDaily.test(out)) out = out.replace(reDaily, DAILY_START + '\n' + daily + '\n' + DAILY_END);

  // ② 游戏时长卡片：从分区注释头开始，整块替换到该卡片结束。
  //    中间无论残留多少行旧标记/旧卡片，都会被一次清掉（幂等，不会越积越多）。
  const re = /<!-- ==================== 游戏时长 ==================== -->[\s\S]*?<\/local:MyCard>/;
  if (re.test(out)) out = out.replace(re, '<!-- ==================== 游戏时长 ==================== -->\n' + card);
  else out = out.trim() + '\n\n' + card;
  return out;
}
let _homeLast = '';
// 每次写盘同时更新两份：
//   1) MC-Timer\PCL主页.xaml         —— 你编辑静态卡片用的母版
//   2) PCL 实际读取的 Custom.xaml   —— 镜像，保证 PCL 里的时长是真的在变
function writeHomepage(force) {
  // 内容没变化时跳过写盘；两份文件都做原子写入，避免 PCL 读到半个文件
  const out = buildHomepage();
  if (!force && out === _homeLast) return;
  _homeLast = out;
  [HOME, PCL_CUSTOM].forEach(p => {
    try {
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, out, 'utf8');
      fs.renameSync(tmp, p);
    } catch (e) { console.log('[home write error]', p, e.message); }
  });
}

// ---------- 面板自定义：背景图 + 整合包文件夹浏览 ----------
// 背景图文件存成 MC-Timer\panel-bg.<扩展名>，界面偏好跟着 mc-time.json 的 ui 走。
const BG_EXTS = ['png', 'jpg', 'gif', 'webp'];
const BG_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
function bgFilePath() { return (db.ui && db.ui.bg) ? path.join(DIR, db.ui.bg) : null; }
function clearBgFiles() {
  BG_EXTS.forEach(ext => { try { fs.unlinkSync(path.join(DIR, 'panel-bg.' + ext)); } catch (e) {} });
}
function fmtDT(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
// 从 PCL 的 Setup.ini（LaunchFolderSelect，UTF-8）猜 Minecraft 根目录，用于自动列出整合包
function mcRootFromPCL() {
  try {
    const ini = path.join(path.dirname(PCL_CUSTOM), 'Setup.ini');
    if (!fs.existsSync(ini)) return null;
    const txt = fs.readFileSync(ini, 'utf8');
    const m = txt.match(/^\s*LaunchFolderSelect\s*[:=]\s*"?([^\r\n"]+)"?/m);
    if (m) {
      const p = m[1].trim().replace(/\\+$/, '');
      if (p && fs.existsSync(p)) return p;
    }
  } catch (e) {}
  return null;
}
// 整合包实例的 mods 文件夹：优先 文件夹/mods，退回 文件夹/.minecraft/mods
function modsRootOf(dir) {
  const a = path.join(dir, 'mods'), b = path.join(dir, '.minecraft', 'mods');
  try { if (fs.statSync(a).isDirectory()) return a; } catch (e) {}
  try { if (fs.statSync(b).isDirectory()) return b; } catch (e) {}
  return null;
}
// ---------- 读取一个整合包文件夹：各部分占用 + 各存档游玩时长 ----------
// 递归累加一个目录的总字节数（有遍历上限，防止巨型目录卡住）
const SIZE_WALK_MAX = 80000;   // 单次遍历文件数上限
function addDirSize(cur, st) {
  let ents = [];
  try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { return; }
  for (const en of ents) {
    if (st.n >= SIZE_WALK_MAX) return;
    if (en.isDirectory()) addDirSize(path.join(cur, en.name), st);
    else {
      st.n++;
      let sz = 0; try { sz = fs.statSync(path.join(cur, en.name)).size; } catch (e) {}
      st.bytes += sz;
    }
  }
}
// 顶层每个子项（mods/config/saves/…）各占多大，按占用从大到小排
function topSizesOf(dir) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const en of ents) {
    const fp = path.join(dir, en.name);
    const st = { bytes: 0, n: 0 };
    if (en.isDirectory()) addDirSize(fp, st);
    else { try { st.bytes = fs.statSync(fp).size; } catch (e) {} }
    out.push({ name: en.name, bytes: st.bytes, isDir: en.isDirectory() });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}
// 扫一个整合包实例文件夹：占用分布 + 各世界时长（不含模组清单——那些 PCL 自己就能看）
function scanPackFolder(dir) {
  let stMs = 0;
  try { stMs = fs.statSync(dir).mtimeMs; } catch (e) {}
  const top = topSizesOf(dir);
  const stats = saveStatsOf(dir);
  const worlds = worldDetailsOf(dir);
  return {
    ok: true, name: path.basename(dir) || dir, path: dir,
    mtime: fmtDT(stMs),
    topSizes: top.slice(0, 12),
    totalBytes: top.reduce((s, x) => s + x.bytes, 0),
    worlds,
    statsSec: Math.floor(stats.statTicks / 20), statsWorlds: stats.worlds, statsLast: fmtDT(stats.lastMs) || ''
  };
}
// 列出某个容器目录（通常就是根目录的 versions）下、长得像整合包实例的子目录
function listInstanceDirs(container) {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(container, { withFileTypes: true }); } catch (e) { return out; }
  ents.forEach(d => {
    if (!d.isDirectory() || d.name.charAt(0) === '.') return;
    const full = path.join(container, d.name);
    if (modsRootOf(full)) out.push({ name: d.name, path: full });
  });
  return out;
}
// 自动猜出来的整合包清单：根目录/versions/*（根目录本身若带 mods 也列入）
function guessPacks() {
  const root = mcRootFromPCL();
  const packs = [];
  if (root) {
    packs.push(...listInstanceDirs(path.join(root, 'versions')));
    if (modsRootOf(root)) packs.push({ name: path.basename(root) || root, path: root });
  }
  return { root, packs };
}
function listSiblingPacks(dir) {
  try { return listInstanceDirs(path.dirname(dir)).filter(x => x.path !== dir); }
  catch (e) { return []; }
}

// ---------- 读存档里的历史时长 + 分辨「当前在玩哪个整合包」 ----------
// 历史时长来源：每个存档(世界)的 saves/<世界>/stats/<uuid>.json，
//   minecraft:custom 下的 play_time 就是该玩家在这个世界玩过的总时长（单位 tick，÷20 = 秒）。
//   新版本键 play_time；1.12 及更早是 play_one_minute；两者都没有时才退回 total_world_time。
const STAT_KEYS = ['minecraft:play_time', 'play_one_minute', 'minecraft:total_world_time'];
const SAVE_JSON_MAX = 400;   // 每包最多读多少个存档统计文件，防止个别超多世界的包拖慢列表
function saveStatsOf(dir) {
  const sd = path.join(dir, 'saves');
  const cand = fs.existsSync(sd) ? sd : path.join(dir, '.minecraft', 'saves');
  const out = { worlds: 0, statTicks: 0, statFiles: 0, lastMs: 0 };
  let ents = [];
  try { ents = fs.readdirSync(cand, { withFileTypes: true }); } catch (e) { return out; }
  for (const w of ents) {
    if (!w.isDirectory() || w.name.charAt(0) === '.') continue;
    if (out.statFiles >= SAVE_JSON_MAX) break;
    let files = [];
    try { files = fs.readdirSync(path.join(cand, w.name, 'stats')); } catch (e) { continue; }
    const js = files.filter(f => /\.json$/i.test(f));
    if (!js.length) continue;
    out.worlds++;   // 只有真的带统计文件的存档才算“能读出时长”
    try { const dm = fs.statSync(path.join(cand, w.name)).mtimeMs; if (dm > out.lastMs) out.lastMs = dm; } catch (e) {}
    let worldBest = 0;
    for (const f of js) {
      if (out.statFiles >= SAVE_JSON_MAX) break;
      out.statFiles++;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(cand, w.name, 'stats', f), 'utf8'));
        const c = (j && j.stats && j.stats['minecraft:custom']) || {};
        for (const k of STAT_KEYS) { const n = Math.floor(Number(c[k]) || 0); if (n > 0) { if (n > worldBest) worldBest = n; break; } }
      } catch (e) {}
    }
    out.statTicks += worldBest;   // 每个世界取该世界最大玩家的时长，再把各世界相加
  }
  return out;
}
// 每个存档(世界)的详情：占用多大、在这个世界玩过多长时间、最近玩（供「读取文件内容」用）
function worldDetailsOf(dir) {
  const sd = path.join(dir, 'saves');
  const cand = fs.existsSync(sd) ? sd : path.join(dir, '.minecraft', 'saves');
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(cand, { withFileTypes: true }); } catch (e) { return out; }
  for (const w of ents) {
    if (!w.isDirectory() || w.name.charAt(0) === '.') continue;
    const wp = path.join(cand, w.name);
    let ticks = 0, statFiles = 0;
    let files = [];
    try { files = fs.readdirSync(path.join(wp, 'stats')).filter(f => /\.json$/i.test(f)); } catch (e) {}
    statFiles = files.length;
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(wp, 'stats', f), 'utf8'));
        const c = (j && j.stats && j.stats['minecraft:custom']) || {};
        for (const k of STAT_KEYS) { const n = Math.floor(Number(c[k]) || 0); if (n > 0) { if (n > ticks) ticks = n; break; } }
      } catch (e) {}
    }
    const st = { bytes: 0, n: 0 };
    addDirSize(wp, st);
    let lm = 0;
    try { lm = fs.statSync(wp).mtimeMs; } catch (e) {}
    out.push({ name: w.name, bytes: st.bytes, hasStats: statFiles > 0, sec: Math.floor(ticks / 20), last: fmtDT(lm) });
  }
  out.sort((a, b) => String(b.last).localeCompare(String(a.last)));
  return out;
}
// 读文件时按多种编码各解一遍（PCL 的 LatestLaunch.bat 是 GBK；英文/UTF-8 时也别读崩）
function readTextCandidates(fp) {
  let buf = null;
  try { buf = fs.readFileSync(fp); } catch (e) { return []; }
  const out = [];
  ['utf8', 'gbk', 'gb18030'].forEach(enc => {
    try { out.push({ enc, text: new TextDecoder(enc).decode(buf) }); } catch (e) {}
  });
  return out;
}
// 从启动脚本里挖出 `cd /D "游戏目录"` 那一行的带盘符路径（去掉尾斜杠；读不到返回 null）
function dirFromLaunchText(text) {
  let m = text.match(/^\s*cd\b[^\r\n]*"([A-Za-z]:[^"]*)"/im);
  if (m) return m[1].replace(/[\\/]+$/, '');
  m = text.match(/"([A-Za-z]:\\[^"]*)"/);
  return m ? m[1].replace(/[\\/]+$/, '') : null;
}
function samePath(a, b) {
  if (!a || !b) return false;
  try { return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase(); } catch (e) { return String(a) === String(b); }
}
// 某个整合包文件夹是否被设为「不计入总榜」（对应 p:<路径> 那条 key）
function isPExcluded(dir) {
  if (!dir) return false;
  const want = String(dir);
  return (db.excl || []).some(k => { try { return k.startsWith('p:') && samePath(k.slice(2), want); } catch (e) { return false; } });
}
// ---------- 文件夹分组（标签式整理，不影响总累计）----------
function cleanKey(k) { k = String(k == null ? '' : k); return (k.length > 2 && (k.startsWith('r:') || k.startsWith('p:'))) ? k : null; }
function folderIdx(name) {
  const w = String(name || '').trim().toLowerCase();
  return (db.folders || []).findIndex(f => String(f.name || '').trim().toLowerCase() === w);
}
// 分辨正在运行的是哪个整合包：读 PCL 每次启动都会重写的 LatestLaunch.bat。
// 解码会有多种结果，取“目录真实存在于磁盘”且“无乱码”的最优候选；读不到就返回 null（交给兜底包）。
function detectRunningPack() {
  try {
    const launch = path.join(path.dirname(PCL_CUSTOM), 'LatestLaunch.bat');
    if (!fs.existsSync(launch)) return null;
    let best = null;
    readTextCandidates(launch).forEach(c => {
      const d = dirFromLaunchText(c.text);
      if (!d) return;
      let onDisk = false;
      try { onDisk = fs.statSync(d).isDirectory(); } catch (e) {}
      const score = (onDisk ? 8 : 0) + (c.text.indexOf('�') < 0 ? 3 : 0) + (c.enc === 'gbk' ? 2 : c.enc === 'utf8' ? 1 : 0);
      if (!best || score > best.score) best = { score, name: path.basename(d) || d, path: d };
    });
    return best ? { name: best.name, path: best.path } : null;
  } catch (e) { return null; }
}
// 分辨/浏览到的整合包落到哪条计时记录：folder 精确路径匹配优先，其次按名字
function matchRecord(name, folder) {
  const byFolder = folder ? db.mods.find(m => m.folder && samePath(m.folder, folder)) : null;
  return byFolder || (name ? db.mods.find(m => m.name === name) : null) || null;
}
function pickTargetByDet(det) { return det ? matchRecord(det.name, det.path) : null; }
// 自动计时时的目标记录：已有对应记录就用它；还没有就自动新建一条（记住文件夹，把
// 存档读出的历史时长当起始累计）—— 这样每个玩过的整合包都会自动出现在列表里。
function autoEnsureRecord(det) {
  if (!det) return null;
  const ex = pickTargetByDet(det);
  if (ex) return ex;
  const stats = saveStatsOf(det.path);
  const rec = {
    id: rnd(), name: det.name,
    folder: String(det.path).slice(0, 300),
    total: Math.floor(stats.statTicks / 20), start: null, autoStarted: false
  };
  db.mods.push(rec);
  if (isPExcluded(det.path) && !isRecExcluded(rec.id)) db.excl.push('r:' + rec.id);
  console.log('[auto] created record for', det.name, 'baseline', rec.total);
  return rec;
}
// 面板列表用的每包汇总：对应计时记录的累计 + 存档统计出的历史时长（一次算好，前端省事）
function enrichPack(p) {
  const rec = matchRecord(p.name, p.path);
  const stats = saveStatsOf(p.path);
  const o = { name: p.name, path: p.path, statsSec: Math.floor(stats.statTicks / 20), statsWorlds: stats.worlds, statsLast: fmtDT(stats.lastMs) || '' };
  if (rec) o.rec = { id: rec.id, total: totalOf(rec), active: !!rec.start, auto: rec.autoStarted };
  return o;
}

// ---------- 历史回填（估算）：Minecraft 不记录“哪天玩了多久”，只能用存档文件的修改
//   日期推断“哪些天玩过”，再把每世界已知总时长按各天出现过的文件数比例摊成近似分钟。
//   只能作估算（日历上会标“≈/估算”），替代不了精确记录 ----------
function estDayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
// 某个世界总时长（tick）：取该世界各 stats json 里最大的玩家 play_time
function worldTotalTicks(worldDir) {
  let ticks = 0, files = [];
  try { files = fs.readdirSync(path.join(worldDir, 'stats')).filter(f => /\.json$/i.test(f)); } catch (e) { return 0; }
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(worldDir, 'stats', f), 'utf8'));
      const c = (j && j.stats && j.stats['minecraft:custom']) || {};
      for (const k of STAT_KEYS) { const n = Math.floor(Number(c[k]) || 0); if (n > 0) { if (n > ticks) ticks = n; break; } }
    } catch (e) {}
  }
  return ticks;
}
// 世界文件夹里“各文件哪天被写过”→ 哪天在玩（level.dat/stats/各维度 region .mca 的修改日期）
function evidenceDates(worldDir) {
  const counts = {};
  const bump = p => { try { const ms = fs.statSync(p).mtimeMs; if (ms) { const k = estDayKey(ms); counts[k] = (counts[k] || 0) + 1; } } catch (e) {} };
  ['level.dat', 'session.lock', 'level.dat_old'].forEach(f => bump(path.join(worldDir, f)));
  try { fs.readdirSync(path.join(worldDir, 'stats')).filter(f => /\.json$/i.test(f)).slice(0, 60).forEach(f => bump(path.join(worldDir, 'stats', f))); } catch (e) {}
  ['region', 'DIM-1/region', 'DIM1/region'].forEach(rel => {
    let ls = [];
    try { ls = fs.readdirSync(path.join(worldDir, rel)).filter(f => /\.mca$/i.test(f)); } catch (e) { return; }
    ls.slice(0, 5000).forEach(f => bump(path.join(worldDir, rel, f)));
  });
  return counts;
}
let histCache = null;
function estimateHistory(force) {
  const ttl = 30 * 60 * 1000;
  if (!force && histCache && (Date.now() - histCache.t) < ttl) return histCache;
  const sec = {}, packs = {};
  const g = guessPacks();
  (g.packs || []).forEach(p => {
    const cand = path.join(p.path, 'saves');
    let worlds = [];
    try { worlds = fs.readdirSync(cand, { withFileTypes: true }).filter(w => w.isDirectory() && w.name.charAt(0) !== '.'); } catch (e) { return; }
    worlds.forEach(w => {
      const wp = path.join(cand, w.name);
      const total = worldTotalTicks(wp) / 20;          // 秒
      if (!(total > 0)) return;
      const cts = evidenceDates(wp);
      const dates = Object.keys(cts);
      if (!dates.length) return;
      const sum = dates.reduce((s, d) => s + cts[d], 0);
      const byDate = {};
      let left = Math.floor(total);
      dates.forEach(d => { byDate[d] = Math.floor(total * cts[d] / sum); left -= byDate[d]; });
      const sorted = dates.slice().sort((a, b) => cts[b] - cts[a]);
      for (let i = 0; i < sorted.length && left > 0; i++) { byDate[sorted[i]]++; left--; }
      Object.keys(byDate).forEach(d => {
        if (byDate[d] > 0) {
          sec[d] = (sec[d] || 0) + byDate[d];
          if (!packs[d]) packs[d] = [];
          if (packs[d].indexOf(p.name) < 0) packs[d].push(p.name);
        }
      });
    });
  });
  // 单日不可能超过 24 小时：个别世界若把总时长几乎都摊到最后写档那天，会压出荒谬值，压回约 23 小时
  Object.keys(sec).forEach(d => { if (sec[d] > 82800) sec[d] = 82800; });
  histCache = { t: Date.now(), sec, packs };
  console.log('[hist] 估算完成：涉及 ' + Object.keys(sec).length + ' 个日期');
  return histCache;
}

// ---------- 自动扫描全盘：找“含存档”的 Minecraft 目录 ----------
// 一个候选目录 = 它自己带 saves\（且里面某个世界有 level.dat），可能是 PCL 实例（versions\<包>）
// 也可能是任意一个 .minecraft（saves 在里面）。找到后“读取”时就用这个目录本身做整包占用拆分。
const DISK_SCAN_TTL = 10 * 60 * 1000;
let diskScanCache = null;
function dirHasSaves(dir) {
  let sd = path.join(dir, 'saves');
  try { if (!fs.statSync(sd).isDirectory()) return false; } catch (e) { return false; }
  try {
    const worlds = fs.readdirSync(sd, { withFileTypes: true });
    let n = 0;
    for (const w of worlds) {
      if (!w.isDirectory() || w.name.charAt(0) === '.') continue;
      if (++n > 300) break;
      try { if (fs.statSync(path.join(sd, w.name, 'level.dat')).isFile()) return true; } catch (e) {}
    }
  } catch (e) {}
  return false;
}
// 系统/无关目录不进：注意不能整块跳过“点开头”（.minecraft 正以点开头，最想找的之一）
const SCAN_SKIP = /^(windows|winnt|win32|program files|program files \(x86\)|programdata|perflogs|recovery|boot|msocache|intel|node_modules|python27|python3\d?|npm-cache|\.git|\.cache|\.vscode|\.idea|\.gradle|\.m2|\.npm|\.claude|cache|logs|temp|tmp|\$recycle\.bin|system volume information)$/i;
function scanDisk(force) {
  if (!force && diskScanCache && Date.now() - diskScanCache.t < DISK_SCAN_TTL) return diskScanCache.v;
  const t0 = Date.now();
  const hits = [], drives = [];
  for (let c = 67; c <= 90; c++) {            // C: .. Z:（A/B 是软驱/读卡器，跳过）
    const l = String.fromCharCode(c) + ':\\';
    try { if (fs.existsSync(l)) drives.push(l); } catch (e) {}
  }
  const perDriveBudget = Math.max(20000, Math.floor(150000 / Math.max(1, drives.length)));
  let scanned = 0, truncated = false;
  const skip = n => !n || SCAN_SKIP.test(n);
  for (const drive of drives) {
    let dscanned = 0;
    const stack = [{ d: drive, depth: 0 }];
    while (stack.length && dscanned < perDriveBudget) {
      const cur = stack.pop();
      dscanned++; scanned++;
      if (dirHasSaves(cur.d)) {
        try {
          const s = saveStatsOf(cur.d);
          hits.push({ name: path.basename(cur.d) || cur.d, path: cur.d, worlds: s.worlds, sec: Math.floor(s.statTicks / 20), last: fmtDT(s.lastMs) });
        } catch (e) {}
        continue;                            // 已是一个实例/游戏目录，不必再往下找
      }
      if (cur.depth >= 9) continue;
      let ents = [];
      try { ents = fs.readdirSync(cur.d, { withFileTypes: true }); } catch (e) { continue; }
      for (const en of ents) {
        if (!en.isDirectory() || skip(en.name)) continue;
        stack.push({ d: path.join(cur.d, en.name), depth: cur.depth + 1 });
      }
    }
    if (dscanned >= perDriveBudget && stack.length) truncated = true;
  }
  hits.sort((a, b) => (b.sec || 0) - (a.sec || 0));
  const out = { ok: true, drives, total: hits.length, hits: hits.slice(0, 300), scanned, partial: truncated, ms: Date.now() - t0 };
  diskScanCache = { t: Date.now(), v: out };
  console.log('[scan] 全盘扫描：' + out.total + ' 个候选，遍历 ' + out.scanned + ' 个目录，' + (out.ms / 1000).toFixed(1) + 's' + (out.partial ? '（目录多已截断）' : ''));
  return out;
}

// ---------- HTTP ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendText(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}
function readBody(req, cb) {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 5e6) req.destroy(); });
  req.on('end', () => cb(d));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, BASE);
  const p = u.pathname;

  // 主页（给 PCL 联网主页用；同时写一份到本地 PCL主页.xaml）
  if (p === '/home.xaml') {
    writeHomepage();
    return sendText(res, 200, buildHomepage());
  }
  // 计时面板页面
  if (p === '/' || p === '/index.html' || p === '/panel.html') {
    try {
      const html = fs.readFileSync(PANEL, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      return sendText(res, 500, 'panel html missing: ' + e.message);
    }
  }
  // 数据读取
  if (p === '/api/data' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, state: stateOut() });
  }
  // 面板背景图（原样返回，配合 no-store，方便换图后即时刷新）
  if (p === '/bg' && req.method === 'GET') {
    const f = bgFilePath();
    if (!f || !fs.existsSync(f)) return sendText(res, 404, 'no bg');
    const ext = String(db.ui.bg).split('.').pop();
    res.writeHead(200, { 'Content-Type': BG_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(f));
  }
  // 自动找整合包：可带 ?dir= 指定一个目录，返回其下像整合包的子目录；不带则从 PCL Setup.ini 猜。
  // 每个包都附上：对应计时记录的累计(rec) + 存档统计的历史时长(statsSec/statsWorlds/statsLast)。
  if (p === '/api/packs' && req.method === 'GET') {
    const dirParam = u.searchParams.get('dir');
    if (dirParam) return sendJson(res, 200, { ok: true, packs: listInstanceDirs(path.resolve(dirParam)).map(enrichPack) });
    const g = guessPacks();
    return sendJson(res, 200, { ok: true, root: g.root, packs: g.packs.map(enrichPack) });
  }
  // 读取一个整合包文件夹的内容：占用分布 + 各世界时长/占用（不读模组清单，PCL 自带那个）
  if (p === '/api/pack' && req.method === 'GET') {
    const dirParam = u.searchParams.get('path');
    if (!dirParam) return sendJson(res, 400, { ok: false, error: '缺少 path' });
    const dir = path.resolve(dirParam);
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch (e) {}
    if (!isDir) return sendJson(res, 400, { ok: false, error: '找不到这个文件夹' });
    const scan = scanPackFolder(dir);
    const siblings = listSiblingPacks(dir).map(enrichPack);
    const rec = matchRecord(path.basename(dir), dir);   // 这个文件夹是否已经有一条计时记录
    return sendJson(res, 200, {
      ok: true, scan, siblings,
      rec: rec ? { id: rec.id, name: rec.name, total: totalOf(rec), active: !!rec.start } : null
    });
  }
  // 自动扫描全盘找存档（较慢；结果缓存 10 分钟，?force=1 强制重扫）
  if (p === '/api/scan' && req.method === 'GET') {
    const sc = scanDisk(u.searchParams.get('force') === '1');
    return sendJson(res, 200, sc);
  }
  // 历史回填（估算）：给日历补旧日期（可能较慢，只首次/30 分钟后算一次）
  if (p === '/api/hist' && req.method === 'GET') {
    const h = estimateHistory(u.searchParams.get('force') === '1');
    return sendJson(res, 200, { ok: true, sec: h.sec, packs: h.packs });
  }
  // 操作
  if (p === '/api/action' && req.method === 'POST') {
    return readBody(req, raw => {
      let cmd;
      try { cmd = JSON.parse(raw || '{}'); } catch (e) { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
      const a = String(cmd.action || '');
      const id = cmd.id ? String(cmd.id) : null;
      const m = id ? find(id) : null;
      let dup = false;   // add 遇到已有同名同目录记录时不重复建

      switch (a) {
        case 'add': {
          const name = String(cmd.name || '').trim() || ('整合包 ' + (db.mods.length + 1));
          const folder = cmd.folder ? String(cmd.folder).trim() : '';
          // 防止重复：这个文件夹已经有一条记录时就不再新建第二条（否则第二条会被主榜藏掉）
          if (folder && db.mods.some(x => x.folder && samePath(x.folder, folder))) { dup = true; break; }
          const rec = { id: rnd(), name, total: 0, start: null, autoStarted: false };
          if (folder) rec.folder = folder;
          // 可选：把该包存档里读出的历史时长作为初始累计（“＋ 记时长”用），从这儿开始继续加
          const seedSec = Math.floor(Number(cmd.seconds) || 0);
          if (seedSec > 0) rec.total = seedSec;
          db.mods.push(rec);
          // 该文件夹之前被设为「不计入总榜」：新记录照样不计入，主榜口径才一致
          if (folder && isPExcluded(folder) && !isRecExcluded(rec.id)) db.excl.push('r:' + rec.id);
          break;
        }
        case 'rename':
          if (m) m.name = String(cmd.name || '').trim() || m.name;
          break;
        case 'del':
          if (m) {
            db.mods = db.mods.filter(x => x.id !== id);
            if (db.auto.packId === id) db.auto.packId = null;
            // 记录没了，r: 那条不计入标记跟着清（文件夹若还被“不计入”则 p: 那条保留，行照旧不计入）
            db.excl = (db.excl || []).filter(k => k !== 'r:' + id);
            // 文件夹分组 / 自定义顺序里的 r: 身份一并清掉（行若还在，p: 身份仍留在分组里）
            (db.folders || []).forEach(f => { if (Array.isArray(f.keys)) f.keys = f.keys.filter(k => k !== 'r:' + id); });
            if (db.ui && Array.isArray(db.ui.order)) db.ui.order = db.ui.order.filter(k => k !== 'r:' + id);
          }
          break;
        case 'start':
          if (m && !m.start) { m.start = now(); m.autoStarted = false; }
          break;
        case 'stop':
          if (m) finalize(m);
          break;
        case 'discard':
          if (m) { m.start = null; m.autoStarted = false; }
          break;
        case 'adjust':
          if (m) { m.total = Math.max(0, (Number(m.total) || 0) + (Math.floor(Number(cmd.seconds) || 0))); }
          break;
        case 'setbg': {
          // 上传背景图：cmd.bg 是一段 data:image/...;base64,...；传 null/空 表示移除背景
          const raw = cmd.bg == null ? null : String(cmd.bg);
          if (!raw) {
            clearBgFiles();
            db.ui.bg = null;
          } else {
            const mm = raw.match(/^data:image\/(png|jpeg|gif|webp);base64,([\s\S]+)$/);
            if (!mm) return sendJson(res, 400, { ok: false, error: '背景图格式不识别（支持 png/jpg/gif/webp）' });
            const ext = mm[1] === 'jpeg' ? 'jpg' : mm[1];
            const buf = Buffer.from(mm[2], 'base64');
            if (!buf.length || buf.length > 15 * 1024 * 1024) return sendJson(res, 400, { ok: false, error: '图片为空或超过 15MB' });
            clearBgFiles();
            const file = 'panel-bg.' + ext;
            try { fs.writeFileSync(path.join(DIR, file), buf); }
            catch (e) { return sendJson(res, 500, { ok: false, error: '保存背景图失败' }); }
            db.ui.bg = file;
          }
          break;
        }
        case 'setdim': {
          const d = Math.floor(Number(cmd.dim));
          db.ui.dim = isNaN(d) ? 50 : Math.min(85, Math.max(0, d));
          break;
        }
        case 'rememberpack':
          db.ui.lastPack = String(cmd.path || '').trim().slice(0, 300);
          break;
        case 'setauto':
          db.auto.enabled = !!cmd.enabled;
          db.auto.packId = (db.mods.some(x => x.id === String(cmd.packId || ''))) ? String(cmd.packId) : (db.auto.packId || null);
          break;
        case 'setnote': {
          // 给某一天写/改备注；空备注表示删除该天备注
          const d = cmd.date ? String(cmd.date) : '';
          if (!DATE_RE.test(d)) return sendJson(res, 400, { ok: false, error: 'bad date' });
          const s = String(cmd.note == null ? '' : cmd.note).trim().slice(0, 500);
          if (s) db.notes[d] = s; else delete db.notes[d];
          break;
        }
        case 'setcount': {
          // 该主榜行是否计入「总累计」：on=true 计入、false 不计入。
          // 一行可能同时挂 r:<记录> 与 p:<文件夹> 两个 key（有记录的行两者都存），
          // 这样删记录/重建记录时「不计入」状态不会丢。
          const on = !!cmd.on;
          const raw = Array.isArray(cmd.keys) ? cmd.keys : (cmd.key ? [cmd.key] : []);
          if (!raw.length) return sendJson(res, 400, { ok: false, error: 'bad key' });
          db.excl = db.excl || [];
          raw.forEach(k => {
            k = String(k || '');
            if (k.length <= 2 || !(k.startsWith('r:') || k.startsWith('p:'))) return;
            const i = db.excl.indexOf(k);
            if (on && i >= 0) db.excl.splice(i, 1);
            if (!on && i < 0) db.excl.push(k);
          });
          break;
        }
        case 'foldset': {
          // 把一行放进 / 移出文件夹：keys 是该行的身份 key（'r:<记录id>' / 'p:<路径>'，
          // 与「不计入总榜」同一套 key，删记录、重建记录都不会丢分组）；folders 是勾选后的目标文件夹名
          // （不存在的名字会自动新建），未勾选的文件夹里会把这行移出去。
          const keys = Array.from(new Set((Array.isArray(cmd.keys) ? cmd.keys : []).map(cleanKey).filter(Boolean)));
          if (!keys.length) return sendJson(res, 400, { ok: false, error: 'bad key' });
          const seenN = {};
          const names = [];
          (Array.isArray(cmd.folders) ? cmd.folders : []).forEach(n => {
            const nm = String(n || '').trim().slice(0, 24);
            if (!nm || seenN[nm.toLowerCase()]) return;
            seenN[nm.toLowerCase()] = 1;
            names.push(nm);
          });
          db.folders = Array.isArray(db.folders) ? db.folders : [];
          db.folders.forEach(f => { if (Array.isArray(f.keys)) f.keys = f.keys.filter(k => keys.indexOf(k) < 0); });
          names.forEach(nm => { if (folderIdx(nm) < 0) db.folders.push({ name: nm, keys: [] }); });
          names.forEach(nm => {
            const f = db.folders[folderIdx(nm)];
            keys.forEach(k => { if (f.keys.indexOf(k) < 0) f.keys.push(k); });
          });
          break;
        }
        case 'addfolder': {
          // 新建一个空文件夹（从主榜条的新建按钮来，之后展开某包放进去）
          const nm = String(cmd.name || '').trim().slice(0, 24);
          if (!nm) return sendJson(res, 400, { ok: false, error: '空文件夹名' });
          db.folders = Array.isArray(db.folders) ? db.folders : [];
          if (folderIdx(nm) < 0) db.folders.push({ name: nm, keys: [] });
          break;
        }
        case 'delfolder': {
          // 删除一个文件夹分组：只删分组本身，里面的包 / 时长一概不动（它们回到「未分组」）
          const nm = String(cmd.name || '').trim();
          db.folders = (Array.isArray(db.folders) ? db.folders : []).filter(f => String(f.name || '').trim().toLowerCase() !== nm.toLowerCase());
          if (db.ui && Array.isArray(db.ui.forder)) db.ui.forder = db.ui.forder.filter(n => String(n || '').trim().toLowerCase() !== nm.toLowerCase());
          break;
        }
        case 'renfolder': {
          // 重命名文件夹；改成已有文件夹的名字时两组合并
          const fr = String(cmd.name || '').trim();
          const to = String(cmd.to || '').trim().slice(0, 24);
          const i = folderIdx(fr);
          if (i < 0 || !to) return sendJson(res, 400, { ok: false, error: 'bad folder' });
          const j = folderIdx(to);
          const merged = (j >= 0 && j !== i);
          if (db.ui && Array.isArray(db.ui.forder)) {
            const fi = db.ui.forder.findIndex(n => String(n || '').trim().toLowerCase() === fr.toLowerCase());
            if (fi >= 0) { if (merged) db.ui.forder.splice(fi, 1); else db.ui.forder[fi] = to; }
            db.ui.forder = Array.from(new Set(db.ui.forder.filter(n => typeof n === 'string' && n))).slice(0, 200);
          }
          if (merged) {
            db.folders[j].keys = Array.from(new Set((db.folders[j].keys || []).concat(db.folders[i].keys || [])));
            db.folders.splice(i, 1);
          } else db.folders[i].name = to;
          break;
        }
        case 'sortorder': {
          // 面板「自定义排序」里用户排好的顺序（面板行 key 的列表，缺失的新行会排在后面）
          db.ui = db.ui || {};
          db.ui.order = Array.from(new Set((Array.isArray(cmd.order) ? cmd.order : []).map(cleanKey).filter(Boolean))).slice(0, 3000);
          break;
        }
        case 'foldorder': {
          // 面板「文件夹自定义排序」里用户排好的文件夹名顺序（缺失的新文件夹排后面）
          db.ui = db.ui || {};
          const _fset = {};
          (db.folders || []).forEach(f => { _fset[String(f.name || '')] = 1; });
          db.ui.forder = Array.from(new Set((Array.isArray(cmd.order) ? cmd.order : []).map(n => String(n || '').trim()).filter(n => n && _fset[n]))).slice(0, 200);
          break;
        }
        case 'setui': {
          // 个性化设置：文字颜色 / 强调色 / 毛玻璃透明度 / 图标样式（传哪个改哪个）
          db.ui = db.ui || {};
          if (typeof cmd.ink === 'string' && /^#[0-9a-fA-F]{6}$/.test(cmd.ink)) db.ui.ink = cmd.ink.toLowerCase();
          if (typeof cmd.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(cmd.accent)) db.ui.accent = cmd.accent.toLowerCase();
          if (cmd.glass != null) { const g = Math.floor(Number(cmd.glass)); db.ui.glass = isNaN(g) ? 50 : Math.min(100, Math.max(0, g)); }
          if (cmd.icons === 'emoji' || cmd.icons === 'plain') db.ui.icons = cmd.icons;
          break;
        }
        case 'import': {
          const o = normalize(cmd.state);
          db = o;
          break;
        }
        case 'reset':
          db = seed();
          break;
        case 'shutdown':
          save();
          sendJson(res, 200, { ok: true, bye: true });
          setTimeout(function () {
            try { server.close(); } catch (e) {}
            process.exit(0);
          }, 150);
          return;
        default:
          return sendJson(res, 400, { ok: false, error: 'unknown action' });
      }
      save();
      sendJson(res, 200, { ok: true, state: stateOut(), dup: !!dup });
    });
  }
  return sendText(res, 404, 'not found');
});

server.listen(PORT, HOST, () => {
  console.log('MC-Timer server running at ' + BASE);
  console.log('PCL local homepage written to: ' + HOME);
  console.log('Mirror (what PCL reads):    ' + PCL_CUSTOM);
  console.log('PCL homepage (online alt): ' + BASE + '/home.xaml');
  console.log('Stop: click 关闭服务 in panel, or kill node.exe');
  writeHomepage(true);
  tick();
});
server.on('error', e => {
  console.log('[server error] ' + e.message);
  if (e.code === 'EADDRINUSE') console.log('Port ' + PORT + ' already in use - is the service already running?');
});
