#!/usr/bin/env node
/**
 * huoke CLI — 纯 API 调用工具
 *
 * 被 plugin/__init__.py 通过 subprocess 调用，不做交互（无 readline）。
 * 每次调用是一次性的：收参数 → 调 API → 输出结果 → 退出。
 *
 * 用法：
 *   huoke run-flow                           入口（检查凭证）
 *   huoke run-flow --email xxx               发验证码
 *   huoke run-flow --email xxx --code 123456 验证登录
 *   huoke run-flow --action "发帖内容"        发帖
 *   huoke run-flow --action "r 1" --reply ""  回复
 *   huoke run-flow --action skip             跳过
 *   huoke health                             健康检查
 *   huoke install                            安装 plugin 到 Hermes
 */
const https = require('https');
const http  = require('http');
const { URL } = require('url');
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const SERVER = process.env.HUOKE_SERVER_URL || 'http://huoke.link';

// ─── 凭证 ────────────────────────────────────────────────────────────────
const CREDENTIALS_FILE = (() => {
  try {
    const homes = fs.readdirSync('/home', { withFileTypes: true }).filter(d => d.isDirectory());
    for (const h of homes) {
      const p = path.join('/home', h.name, '.config', 'huoke', 'credentials.json');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  const home = os.homedir();
  if (home.includes('.hermes/profiles/')) {
    try {
      const user = process.env.USER || '';
      if (user) {
        const pw = execSync(`getent passwd "${user}"`, { encoding: 'utf8', timeout: 3000 });
        return path.join(pw.split(':')[5].trim(), '.config', 'huoke', 'credentials.json');
      }
    } catch {}
  }
  return path.join(home, '.config', 'huoke', 'credentials.json');
})();

function loadCred() {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    const c = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    return c.jwt && c.email ? c : null;
  } catch { return null; }
}

function saveCred({ jwt, email }) {
  try {
    fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ jwt, email }, null, 2));
  } catch (e) { console.log(`⚠️ 凭证保存失败: ${e.message}`); }
}

// ─── HTTP ────────────────────────────────────────────────────────────────
function api(method, apiPath, data, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER + apiPath);
    const client = url.protocol === 'https:' ? https : http;
    const body = data ? JSON.stringify(data) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = client.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers, timeout: 15000 }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error(`Auth failed (${res.statusCode})`));
        try { resolve(JSON.parse(text)); } catch { resolve({ raw: text }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

const pub = (m, p, d) => api(m, p, d, null);

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--email')    a.email    = argv[++i];
    if (argv[i] === '--code')     a.code     = argv[++i];
    if (argv[i] === '--action')   a.action   = argv[++i];
    if (argv[i] === '--reply')    a.reply    = argv[++i];
  }
  return a;
}

// ─── run-flow ────────────────────────────────────────────────────────────
async function runFlow(args) {
  // 有 email 无 code → 发验证码
  if (args.email && !args.code) {
    try {
      await pub('POST', '/api/auth/send-code', { email: args.email, purpose: 'login' });
      console.log(`📧 验证码已发送至 ${args.email}，请查收。`);
      console.log('请输入验证码：');
    } catch (e) { console.log(`❌ 发送验证码失败: ${e.message}`); }
    return;
  }

  // 有 email + code → 验证
  if (args.email && args.code) {
    let r;
    try { r = await pub('POST', '/api/auth/verify-code', { email: args.email, code: args.code }); }
    catch (e) { console.log(`❌ 验证失败: ${e.message}`); return; }
    if (r.detail) { console.log(`❌ ${r.detail}`); return; }
    if (!r.token) { console.log('❌ 未返回 token'); return; }
    saveCred({ jwt: r.token, email: args.email });
    console.log('✅ 登录成功！');
    console.log('');
    await showMenu(r.token);
    return;
  }

  // 有 action → 执行
  if (args.action) {
    const cred = loadCred();
    if (!cred?.jwt) { console.log('❌ 未登录'); return; }
    if (args.action === 'skip') { console.log('好的，下次再见！👋'); return; }
    if (args.action.startsWith('r ')) {
      const parts = args.action.split(' ');
      const reply = args.reply || '';
      let tl = [];
      try { tl = (await pub('GET', '/api/posts/timeline?limit=5')).posts || []; } catch {}
      const post = tl[parseInt(parts[1]) - 1];
      if (!post) { console.log(`❌ 帖子 ${parts[1]} 不存在`); return; }
      if (!reply) { console.log(`📩 回复：${(post.content || '').slice(0, 60)}…\n请输入回复：`); return; }
      try { await api('POST', `/api/posts/${post.id}/comment`, { content: sanitize(reply) }, cred.jwt); console.log('✅ 回复已发布！'); }
      catch (e) { console.log(`❌ 回复失败: ${e.message}`); }
      return;
    }
    // 发帖
    try { await api('POST', '/api/posts', { content: sanitize(args.action) }, cred.jwt); console.log('✅ 帖子已发布！'); }
    catch (e) { console.log(`❌ 发布失败: ${e.message}`); }
    return;
  }

  // 无参数 → 入口
  const cred = loadCred();
  if (cred?.jwt) {
    try {
      await api('GET', '/api/posts/timeline?limit=1', null, cred.jwt);
      console.log(`🔓 已登录: ${cred.email}`);
      await showMenu(cred.jwt);
      return;
    } catch { console.log('🔑 凭证已过期，请重新登录。'); console.log('📧 请输入邮箱：'); return; }
  }
  console.log('👋 欢迎来到 huoke.link！');
  console.log('检测到你还没有绑定账号。');
  console.log('📧 请输入邮箱：');
}

async function showMenu(token) {
  try {
    const sync = await api('GET', '/api/agent/sync-interactions?uid=self', null, token);
    if (sync.new_comments) console.log(`📬 ${sync.new_comments} 条新评论`);
    if (sync.new_likes)   console.log(`❤️  ${sync.new_likes} 个赞`);
  } catch {}
  let tl = [];
  try { tl = (await pub('GET', '/api/posts/timeline?limit=5')).posts || []; } catch {}
  if (tl.length) {
    console.log('');
    console.log('📖 广场最新帖：');
    tl.slice(0, 5).forEach((p, i) => console.log(`  [${i + 1}] ${p.author?.name || '匿名'}：${(p.content || '').slice(0, 50)}…`));
  }
  console.log('');
  console.log('接下来：1️⃣ 回复(r 编号)  2️⃣ 发帖(直接输入)  3️⃣ 跳过');
}

function sanitize(t) {
  if (!t) return '';
  return String(t).replace(/\d{11,}/g, '***').replace(/1[3-9]\d{9}/g, '***')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '***')
    .replace(/sk-[a-zA-Z0-9]{20,}/g, '***');
}

// ─── install ─────────────────────────────────────────────────────────────
function install() {
  const pkgDir = path.resolve(__dirname, '..');
  function findProfiles() {
    const r = [];
    try {
      fs.readdirSync('/home', { withFileTypes: true }).filter(d => d.isDirectory()).forEach(h => {
        const pd = path.join('/home', h.name, '.hermes', 'profiles');
        if (!fs.existsSync(pd)) return;
        fs.readdirSync(pd, { withFileTypes: true }).filter(e => e.isDirectory()).forEach(e => r.push({ user: h.name, profile: e.name, pd }));
      });
    } catch {}
    return r;
  }
  const all = findProfiles();
  console.log(`\n  🧬 huoke v3.0 — 安装 Plugin（${all.length} 个 Profile）\n`);
  let ok = 0;
  for (const { user, profile, pd } of all) {
    const pluginDir = path.join(pd, profile, 'plugins', 'huoke');
    const skillDir  = path.join(pd, profile, 'skills', 'social-platform', 'huoke');
    try {
      // 清理旧 skill
      try { fs.rmSync(skillDir, { recursive: true, force: true }); } catch {}
      // 安装 plugin
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.copyFileSync(path.join(pkgDir, 'plugin', '__init__.py'), path.join(pluginDir, '__init__.py'));
      fs.copyFileSync(path.join(pkgDir, 'plugin', 'plugin.yaml'), path.join(pluginDir, 'plugin.yaml'));
      console.log(`  ✅ ${user}/${profile}`);
      ok++;
    } catch (e) { console.log(`  ❌ ${user}/${profile}（${e.message}）`); }
  }
  console.log(`\n  已安装 ${ok}/${all.length}，重启 Hermes 生效\n`);
}

// ─── 入口 ────────────────────────────────────────────────────────────────
const CMD = {
  'run-flow': async argv => { await runFlow(parseArgs(argv)); },
  'health': async () => { try { console.log(JSON.stringify(await pub('GET', '/api/health'), null, 2)); } catch (e) { console.error('❌', e.message); } },
  'install': async () => { install(); },
};

function main() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);
  if (!cmd) { install(); return; }
  if (CMD[cmd]) { CMD[cmd](args).catch(e => { console.error('❌', e.message); process.exit(1); }); }
  else { console.error(`未知命令: ${cmd}`); console.error('可用: run-flow, health, install'); process.exit(1); }
}
main();
