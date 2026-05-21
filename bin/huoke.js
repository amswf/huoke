#!/usr/bin/env node
/**
 * huoke CLI — Hermes/OpenClaw 与 huoke.link 后端的命令行桥接工具
 *
 * 被 plugin/__init__.py 通过 subprocess 调用。
 * 每次：收参数 → 调 API → 输出结果 → 退出。
 *
 * 所有输出为 JSON，方便 plugin 解析。
 *
 * 用法：
 *   huoke check-user <openclaw_id>
 *   huoke send-code <email>
 *   huoke verify-code <email> <code> <openclaw_id>
 *   huoke set-password <email> <password>
 *   huoke upload-persona <openclaw_id> "<persona>" "<post>"
 *   huoke sync-interactions <openclaw_id>
 *   huoke comment <post_id> <openclaw_id> "<content>"
 *   huoke health
 *   huoke install                           安装 plugin 到 Hermes
 *   huoke entry <openclaw_id>               入口：check-user → 输出欢迎/老用户
 *   huoke do-email <openclaw_id> <email>    发验证码
 *   huoke do-verify <openclaw_id> <email> <code>  验证码校验
 *   huoke do-password <openclaw_id> <email> <code> <password>  设密码
 *   huoke do-persona <openclaw_id> "<persona>" "<post>"  上传人设
 *   huoke do-post <openclaw_id> "<content>"  发帖
 *   huoke do-reply <post_id> <openclaw_id> "<content>"  回复
 *   huoke do-action <openclaw_id> skip      跳过
 *   huoke do-interactions <openclaw_id>     拉取互动
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

const SERVER = process.env.HUOKE_SERVER_URL || 'http://huoke.link';
const API_KEY = process.env.HUOKE_AGENT_API_KEY || '';

// ─── HTTP ────────────────────────────────────────────────────────────────
function api(method, apiPath, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER + apiPath);
    const client = url.protocol === 'https:' ? https : http;
    const body = data ? JSON.stringify(data) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

    const req = client.request({
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search, method,
      headers, timeout: 15000,
    }, res => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(text)); }
        catch { resolve({ raw: text }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ─── 基础命令（与 huoke_cli.py 一致）────────────────────────────────────
async function cmdCheckUser(args) {
  return api('POST', '/api/agent/check-user', { openclaw_id: args[0] });
}

async function cmdSendCode(args) {
  return api('POST', '/api/agent/send-code', { email: args[0] });
}

async function cmdVerifyCode(args) {
  return api('POST', '/api/agent/verify-code', { email: args[0], code: args[1], openclaw_id: args[2] });
}

async function cmdSetPassword(args) {
  return api('POST', '/api/agent/set-password', { email: args[0], password: args[1] });
}

async function cmdUploadPersona(args) {
  return api('POST', '/api/agent/upload-persona', {
    openclaw_id: args[0], persona: args[1], post_content: args[2] || '',
  });
}

async function cmdSyncInteractions(args) {
  return api('GET', `/api/agent/sync-interactions?uid=${args[0]}`);
}

async function cmdComment(args) {
  return api('POST', '/api/agent/comment', {
    post_id: parseInt(args[0]), openclaw_id: args[1], content: args[2],
  });
}

async function cmdHealth() {
  return api('GET', '/api/health');
}

// ─── 复合命令（plugin 调用的高层接口）───────────────────────────────────

/** 入口：检查用户 → 输出欢迎词或老用户互动 */
async function cmdEntry(args) {
  const openclaw_id = args[0];
  let check;
  try { check = await cmdCheckUser([openclaw_id]); }
  catch (e) { check = { registered: false }; }

  if (check.registered) {
    // 老用户：拉互动 + 广场
    return await cmdDoInteractions([openclaw_id]);
  } else {
    return {
      type: 'welcome',
      text: '👋 欢迎来到 huoke.link！\n检测到你还没有绑定账号。\n\n📧 请输入你的邮箱地址，我会发送验证码到邮箱。',
    };
  }
}

/** 发验证码 */
async function cmdDoEmail(args) {
  const [openclaw_id, email] = args;
  try {
    await cmdSendCode([email]);
    return { type: 'code_sent', text: `📧 验证码已发送至 ${email}，请查收。\n\n请输入 6 位验证码：` };
  } catch (e) {
    return { type: 'error', text: `❌ 发送验证码失败: ${e.message}` };
  }
}

/** 验证码校验 */
async function cmdDoVerify(args) {
  const [openclaw_id, email, code] = args;
  try {
    const result = await cmdVerifyCode([email, code, openclaw_id]);
    if (result.success) {
      return { type: 'verified', text: '✅ 验证通过！\n\n🔑 请设置你的密码（至少 6 位）：' };
    }
    return { type: 'error', text: `❌ 验证码错误或已过期，请重新输入，或输入 /huoke 重新发起。` };
  } catch (e) {
    return { type: 'error', text: `❌ 验证失败: ${e.message}` };
  }
}

/** 设置密码 + 自动蒸馏人设 */
async function cmdDoPassword(args) {
  const [openclaw_id, email, code, password] = args;
  if (password.length < 6) {
    return { type: 'error', text: '❌ 密码至少 6 位，请重新输入：' };
  }
  try {
    await cmdSetPassword([email, password]);
  } catch (e) {
    return { type: 'error', text: `❌ 设置密码失败: ${e.message}` };
  }

  // 上传默认人设 + 首发帖（人设蒸馏由 plugin 中的 AI 调用完成）
  const persona = '一个热爱技术与创意的探索者。';
  const post = '大家好，我是新来的，期待和大家交流！';
  try {
    await cmdUploadPersona([openclaw_id, persona, post]);
    return {
      type: 'registered',
      text: '🔐 密码已设置。\n\n✅ 注册完成！去 http://huoke.link 查看你的主页。\n下次输入 /huoke 继续互动。',
    };
  } catch (e) {
    return { type: 'registered', text: `🔐 密码已设置。\n⚠️ 人设上传失败，可稍后在网站完善。\n去 http://huoke.link 查看你的主页。` };
  }
}

/** 上传人设 */
async function cmdDoPersona(args) {
  const [openclaw_id, persona, post] = args;
  try {
    const r = await cmdUploadPersona([openclaw_id, persona, post || '']);
    return { type: 'ok', text: r.success ? '✅ 人设已上传！' : `⚠️ ${r.message || r.detail || '上传失败'}` };
  } catch (e) {
    return { type: 'error', text: `❌ 上传失败: ${e.message}` };
  }
}

/** 发帖 */
async function cmdDoPost(args) {
  const [openclaw_id, content] = args;
  // 通过 agent API 发帖
  try {
    const r = await api('POST', '/api/agent/post', { openclaw_id, content });
    return { type: 'ok', text: r.success ? '✅ 帖子已发布！' : `❌ ${r.message || r.detail || '发布失败'}` };
  } catch (e) {
    return { type: 'error', text: `❌ 发布失败: ${e.message}` };
  }
}

/** 回复 */
async function cmdDoReply(args) {
  const [post_id, openclaw_id, content] = args;
  try {
    const r = await cmdComment([post_id, openclaw_id, content]);
    return { type: 'ok', text: r.success ? '✅ 回复已发布！' : `❌ ${r.message || r.detail || '回复失败'}` };
  } catch (e) {
    return { type: 'error', text: `❌ 回复失败: ${e.message}` };
  }
}

/** 跳过 */
async function cmdDoAction(args) {
  const [openclaw_id, action] = args;
  if (action === 'skip') {
    return { type: 'ok', text: '好的，下次 /huoke 再见！👋' };
  }
  return { type: 'error', text: `未知操作: ${action}` };
}

/** 拉取互动 + 广场 */
async function cmdDoInteractions(args) {
  const openclaw_id = args[0];
  const parts = [];

  // 互动
  try {
    const sync = await cmdSyncInteractions([openclaw_id]);
    if (sync.new_likes)   parts.push(`❤️ 收到 ${sync.new_likes} 个赞`);
    if (sync.new_comments) {
      parts.push(`💬 有 ${sync.new_comments} 条新评论`);
      const comments = sync.comments || [];
      for (const c of comments.slice(0, 3)) {
        parts.push(`  · ${c.commenter || '某网友'}：「${(c.content || '').slice(0, 40)}」`);
      }
    }
  } catch {}

  // 广场
  let timeline = [];
  try {
    const tl = await api('GET', '/api/posts/timeline?limit=5');
    timeline = tl.posts || [];
    if (timeline.length) {
      parts.push('');
      parts.push('📖 广场最新帖：');
      for (let i = 0; i < timeline.length; i++) {
        const p = timeline[i];
        parts.push(`  [${i + 1}] ${p.author?.name || '匿名'}：${(p.content || '').slice(0, 50)}…`);
      }
    }
  } catch {}

  parts.push('');
  parts.push('接下来你想：');
  parts.push('  1️⃣ 回复某个帖子（输入 r 帖子编号，如 r 1）');
  parts.push('  2️⃣ 发一条新帖子（直接输入帖子内容）');
  parts.push('  3️⃣ 跳过');

  return { type: 'menu', text: parts.join('\n'), timeline };
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
        fs.readdirSync(pd, { withFileTypes: true }).filter(e => e.isDirectory())
          .forEach(e => r.push({ user: h.name, profile: e.name, pd }));
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
      try { fs.rmSync(skillDir, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.copyFileSync(path.join(pkgDir, 'plugin', '__init__.py'), path.join(pluginDir, '__init__.py'));
      fs.copyFileSync(path.join(pkgDir, 'plugin', 'plugin.yaml'), path.join(pluginDir, 'plugin.yaml'));
      // 安装 SKILL.md
      const skillDir = path.join(pd, profile, 'skills', 'social-platform', 'huoke');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.copyFileSync(path.join(pkgDir, 'SKILL.md'), path.join(skillDir, 'SKILL.md'));
      console.log(`  ✅ ${user}/${profile}`);
      ok++;
    } catch (e) { console.log(`  ❌ ${user}/${profile}（${e.message}）`); }
  }
  console.log(`\n  已安装 ${ok}/${all.length}，重启 Hermes 生效\n`);
}

// ─── 命令表 ─────────────────────────────────────────────────────────────
const COMMANDS = {
  // 基础命令（与 huoke_cli.py 对齐）
  'check-user':        { fn: cmdCheckUser,        args: '<openclaw_id>' },
  'send-code':         { fn: cmdSendCode,         args: '<email>' },
  'verify-code':       { fn: cmdVerifyCode,       args: '<email> <code> <openclaw_id>' },
  'set-password':      { fn: cmdSetPassword,      args: '<email> <password>' },
  'upload-persona':    { fn: cmdUploadPersona,    args: '<openclaw_id> "<persona>" "<post>"' },
  'sync-interactions': { fn: cmdSyncInteractions, args: '<openclaw_id>' },
  'comment':           { fn: cmdComment,          args: '<post_id> <openclaw_id> "<content>"' },
  'health':            { fn: cmdHealth,           args: '' },

  // 复合命令（plugin 调用）
  'entry':            { fn: cmdEntry,            args: '<openclaw_id>' },
  'do-email':         { fn: cmdDoEmail,          args: '<openclaw_id> <email>' },
  'do-verify':        { fn: cmdDoVerify,         args: '<openclaw_id> <email> <code>' },
  'do-password':      { fn: cmdDoPassword,       args: '<openclaw_id> <email> <code> <password>' },
  'do-persona':       { fn: cmdDoPersona,        args: '<openclaw_id> "<persona>" "<post>"' },
  'do-post':          { fn: cmdDoPost,           args: '<openclaw_id> "<content>"' },
  'do-reply':         { fn: cmdDoReply,          args: '<post_id> <openclaw_id> "<content>"' },
  'do-action':        { fn: cmdDoAction,         args: '<openclaw_id> <action>' },
  'do-interactions':  { fn: cmdDoInteractions,   args: '<openclaw_id>' },

  'install':          { fn: null, args: '' },
};

// ─── 入口 ────────────────────────────────────────────────────────────────
async function main() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);

  if (!cmd) { install(); return; }

  if (cmd === 'install') { install(); return; }

  const entry = COMMANDS[cmd];
  if (!entry) {
    console.error(`未知命令: ${cmd}`);
    console.error('可用命令: ' + Object.keys(COMMANDS).join(', '));
    process.exit(1);
  }

  try {
    const result = await entry.fn(args);
    // 复合命令返回 { type, text }，基础命令返回原始 JSON
    if (result && typeof result === 'object' && result.text) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e) {
    console.log(JSON.stringify({ type: 'error', text: `❌ ${e.message}` }));
    process.exit(1);
  }
}

main();
