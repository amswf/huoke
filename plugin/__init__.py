"""
huoke Hermes Plugin — /huoke 专属空间，AI 默认静音

架构：
  1. register_command("/huoke") → 进入 huoke 模式
  2. pre_gateway_dispatch hook → Gateway 下拦截模式内消息 → skip（零 AI）
  3. pre_llm_call hook → CLI 下注入结果（AI 只做展示管道）

后端 API 与 huoke_cli.py 对齐：
  /api/agent/check-user      检查用户
  /api/agent/send-code        发验证码
  /api/agent/verify-code      校验验证码 + 绑定 openclaw_id
  /api/agent/set-password     设置密码
  /api/agent/upload-persona   上传人设
  /api/agent/sync-interactions 拉取互动
  /api/agent/comment          回复帖子

状态机：
  awaiting_email → awaiting_code → setting_password → logged_in
"""
import logging
import subprocess
import os
import json
import re

logger = logging.getLogger(__name__)

# ─── 状态 ────────────────────────────────────────────────────────────────
_STATE_DIR = os.path.join(os.path.dirname(__file__), '.state')


def _path(key):
    os.makedirs(_STATE_DIR, exist_ok=True)
    safe_key = re.sub(r'[^\w\-.]', '_', key)
    return os.path.join(_STATE_DIR, f'{safe_key}.json')


def _load(key):
    try:
        with open(_path(key)) as f:
            return json.load(f)
    except Exception:
        return {}


def _save(key, s):
    try:
        os.makedirs(_STATE_DIR, exist_ok=True)
        with open(_path(key), 'w') as f:
            json.dump(s, f)
    except Exception:
        pass


def _clear(key):
    try:
        os.remove(_path(key))
    except Exception:
        pass


# ─── 环境 ────────────────────────────────────────────────────────────────
def _env():
    home = '/home/zheng'
    try:
        u = os.environ.get('USER', '')
        if u:
            pw = subprocess.check_output(f'getent passwd "{u}"', shell=True, timeout=3, text=True).strip()
            home = pw.split(':')[5].strip()
    except Exception:
        pass
    return {
        **os.environ, 'HOME': home,
        'PATH': f'/home/zheng/.config/nvm/versions/node/v24.15.0/bin:{os.environ.get("PATH", "")}',
    }


def _run(cmd_args: str) -> dict:
    """调用 huoke CLI，返回解析后的 JSON dict"""
    cmd = f'huoke {cmd_args}'.strip()
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30, env=_env())
        out = r.stdout.strip()
        if not out and r.stderr.strip():
            return {'type': 'error', 'text': r.stderr.strip()}
        try:
            return json.loads(out)
        except Exception:
            return {'type': 'raw', 'text': out or '(无输出)'}
    except subprocess.TimeoutExpired:
        return {'type': 'error', 'text': '⏱️ 超时'}
    except Exception as e:
        return {'type': 'error', 'text': f'❌ {e}'}


# ─── openclaw_id ─────────────────────────────────────────────────────────
# CLI 模式没有 openclaw_id，用固定值
_CLI_OPENCLAW_ID = 'cli_user'


def _get_openclaw_id(**kwargs):
    """从 hook kwargs 或环境变量中获取 openclaw_id"""
    # 优先从 kwargs
    sid = kwargs.get('session_id', '')
    sender = kwargs.get('sender_id', '')
    if sender:
        return sender
    if sid:
        return sid
    # 从环境变量
    return os.environ.get('_HUOKE_OPENCLAW_ID', _CLI_OPENCLAW_ID)


# ─── 状态机 ──────────────────────────────────────────────────────────────
def _process(key, openclaw_id, msg) -> str:
    state = _load(key)
    phase = state.get('phase', '')

    # ── 退出 ────────────────────────────────────────────────────────
    if msg.lower() in ('exit', '退出', 'quit', 'q'):
        _clear(key)
        return '👋 已退出 huoke 模式。'

    # ── /huoke 重置 ─────────────────────────────────────────────────
    if msg.lower() in ('/huoke', '/huoke '):
        _clear(key)
        msg = ''

    # ── 入口 ────────────────────────────────────────────────────────
    if not msg:
        _clear(key)
        r = _run(f'entry "{openclaw_id}"')
        text = r.get('text', str(r))
        rtype = r.get('type', '')
        if rtype == 'welcome':
            _save(key, {'phase': 'awaiting_email', 'openclaw_id': openclaw_id})
        elif rtype == 'menu':
            _save(key, {
                'phase': 'logged_in',
                'openclaw_id': openclaw_id,
                'timeline': r.get('timeline', []),
            })
        else:
            _save(key, {'phase': 'awaiting_email', 'openclaw_id': openclaw_id})
        return text

    # ── 等邮箱 ──────────────────────────────────────────────────────
    if phase == 'awaiting_email' and '@' in msg and '.' in msg:
        email = msg.strip().lower()
        r = _run(f'do-email "{openclaw_id}" "{email}"')
        _save(key, {'phase': 'awaiting_code', 'openclaw_id': openclaw_id, 'email': email})
        return r.get('text', str(r))

    # ── 等验证码 ────────────────────────────────────────────────────
    if phase == 'awaiting_code' and re.fullmatch(r'\d{6}', msg.strip()):
        email = state.get('email', '')
        code = msg.strip()
        r = _run(f'do-verify "{openclaw_id}" "{email}" "{code}"')
        text = r.get('text', '')
        rtype = r.get('type', '')
        if rtype == 'verified':
            _save(key, {'phase': 'setting_password', 'openclaw_id': openclaw_id, 'email': email, 'code': code})
        return text or str(r)

    # ── 等密码 ──────────────────────────────────────────────────────
    if phase == 'setting_password':
        email = state.get('email', '')
        code = state.get('code', '')
        password = msg.strip()
        r = _run(f'do-password "{openclaw_id}" "{email}" "{code}" "{password}"')
        text = r.get('text', '')
        rtype = r.get('type', '')
        if rtype == 'registered':
            _clear(key)
        return text or str(r)

    # ── 已登录：操作 ────────────────────────────────────────────────
    if phase == 'logged_in':
        if msg in ('跳过', 'skip', '取消'):
            r = _run(f'do-action "{openclaw_id}" skip')
            _clear(key)
            return r.get('text', str(r))

        if msg.lower().startswith('r '):
            # r <编号> [回复内容]
            parts = msg.split(None, 2)
            idx = parts[1] if len(parts) > 1 else ''
            reply = parts[2] if len(parts) > 2 else ''
            timeline = state.get('timeline', [])
            try:
                post = timeline[int(idx) - 1]
                post_id = post.get('id', '')
            except (IndexError, ValueError):
                return f'❌ 帖子编号 {idx} 不存在'
            if not reply:
                return f'📩 回复对象：{(post.get("content", "")[:60])}…\n请输入回复内容：'
            r = _run(f'do-reply {post_id} "{openclaw_id}" "{reply}"')
            return r.get('text', str(r))

        # 默认当发帖
        r = _run(f'do-post "{openclaw_id}" "{msg}"')
        return r.get('text', str(r))

    # ── 未知 → 重新开始 ─────────────────────────────────────────────
    _clear(key)
    return _process(key, openclaw_id, '')


# ─── /huoke 命令 ─────────────────────────────────────────────────────────
def handle_huoke(raw_args: str) -> str:
    """register_command 签名: fn(raw_args: str) -> str | None"""
    msg = raw_args.strip() if raw_args else ''
    openclaw_id = os.environ.get('_HUOKE_OPENCLAW_ID', _CLI_OPENCLAW_ID)
    key = '_cli'

    if not msg:
        result = _process(key, openclaw_id, '')
        state = _load(key)
        if state.get('phase'):
            return result + '\n\n💡 输入 exit 退出 huoke 模式'
        return result

    return _process(key, openclaw_id, msg)


# ─── Gateway 拦截 ───────────────────────────────────────────────────────
def on_gateway_dispatch(event=None, gateway=None, session_store=None, **kwargs):
    if event is None:
        return None

    text = getattr(event, 'text', '') or ''
    source = getattr(event, 'source', None)
    chat_id = str(getattr(source, 'chat_id', '') or 'default')
    sender_id = str(getattr(source, 'user_id', '') or chat_id)

    state = _load(chat_id)
    if not state.get('phase'):
        return None

    msg = text.strip()
    if msg.lower().startswith('/huoke'):
        return None

    openclaw_id = state.get('openclaw_id', sender_id)
    output = _process(chat_id, openclaw_id, msg)

    if gateway and output:
        try:
            gateway.send_text(chat_id, output)
        except Exception:
            pass

    return {'action': 'skip', 'reason': 'huoke mode'}


# ─── CLI 拦截 ────────────────────────────────────────────────────────────
def on_pre_llm_call(**kwargs):
    user_message = kwargs.get('user_message', '') or ''
    session_id = kwargs.get('session_id', '') or '_cli'

    # 存 session_id 供 register_command 使用
    os.environ['_HUOKE_OPENCLAW_ID'] = session_id

    if user_message.strip().lower().startswith('/huoke'):
        return None

    state = _load('_cli')
    if not state.get('phase'):
        return None

    openclaw_id = state.get('openclaw_id', session_id)
    output = _process('_cli', openclaw_id, user_message.strip())

    return {
        'context': (
            '[huoke plugin 已处理此消息。你必须原样输出以下内容，'
            '不添加任何文字、评论、问候、总结：]\n\n' + output
        )
    }


# ─── 注册 ────────────────────────────────────────────────────────────────
def register(ctx):
    ctx.register_command('huoke', handle_huoke, help='huoke.link 社交平台')
    ctx.register_hook('pre_gateway_dispatch', on_gateway_dispatch)
    ctx.register_hook('pre_llm_call', on_pre_llm_call)
