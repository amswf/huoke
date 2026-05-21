"""
huoke Hermes Plugin — /huoke 专属空间，AI 默认静音

架构：
  1. register_command("/huoke") → 进入 huoke 模式，处理 /huoke 开头的消息
  2. pre_gateway_dispatch hook  → gateway(Telegram/Discord) 下拦截模式内所有消息
     返回 {"action": "skip"} → 消息不到 LLM，零 AI 参与
  3. pre_llm_call hook          → CLI 下拦截模式内消息
     注入处理结果，AI 只做展示管道

状态管理：
  CLI 模式：单用户，固定 key "_cli"
  Gateway 模式：按 chat_id 隔离
  状态持久化到 JSON 文件，跨消息调用不丢失
"""
import logging
import subprocess
import os
import json
import re

logger = logging.getLogger(__name__)

# ─── 状态管理 ────────────────────────────────────────────────────────────
_STATE_DIR = os.path.join(os.path.dirname(__file__), '.state')


def _state_path(key: str) -> str:
    os.makedirs(_STATE_DIR, exist_ok=True)
    safe = re.sub(r'[^\w\-.]', '_', key)
    return os.path.join(_STATE_DIR, f'{safe}.json')


def _load(key: str) -> dict:
    try:
        with open(_state_path(key), 'r') as f:
            return json.load(f)
    except Exception:
        return {}


def _save(key: str, state: dict):
    try:
        os.makedirs(_STATE_DIR, exist_ok=True)
        with open(_state_path(key), 'w') as f:
            json.dump(state, f)
    except Exception:
        pass


def _clear(key: str):
    try:
        os.remove(_state_path(key))
    except Exception:
        pass


# ─── 子进程环境 ──────────────────────────────────────────────────────────
def _env():
    home = '/home/zheng'
    try:
        user = os.environ.get('USER', '')
        if user:
            pw = subprocess.check_output(
                f'getent passwd "{user}"', shell=True, timeout=3, text=True
            ).strip()
            home = pw.split(':')[5].strip()
    except Exception:
        pass
    return {
        **os.environ,
        'HOME': home,
        'PATH': f'/home/zheng/.config/nvm/versions/node/v24.15.0/bin:{os.environ.get("PATH", "")}',
    }


# ─── 调用 huoke CLI ─────────────────────────────────────────────────────
def _run(args: str) -> str:
    cmd = f'huoke run-flow {args}'.strip()
    try:
        r = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            timeout=30, env=_env(),
        )
        out = r.stdout.strip()
        if r.stderr.strip():
            out = (out + '\n' + r.stderr.strip()).strip()
        return out or '(无输出)'
    except subprocess.TimeoutExpired:
        return '⏱️ 超时，请重试'
    except Exception as e:
        logger.error('huoke failed: %s', e)
        return f'❌ 失败: {e}'


# ─── 核心状态机 ──────────────────────────────────────────────────────────
def _process(key: str, msg: str) -> str:
    """根据状态和消息执行 CLI，返回输出。"""
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

    # ── 入口：无参数 ────────────────────────────────────────────────
    if not msg:
        _clear(key)
        output = _run('')
        _save(key, {'phase': 'awaiting_email'})
        return output

    # ── 等邮箱（含 @） ──────────────────────────────────────────────
    if phase == 'awaiting_email' and '@' in msg and '.' in msg:
        email = msg.strip().lower()
        output = _run(f'--email "{email}"')
        _save(key, {'phase': 'awaiting_code', 'email': email})
        return output

    # ── 等验证码（6位数字） ────────────────────────────────────────
    if phase == 'awaiting_code' and re.fullmatch(r'\d{6}', msg.strip()):
        email = state.get('email', '')
        code = msg.strip()
        output = _run(f'--email "{email}" --code "{code}"')
        if '登录成功' in output or '已登录' in output:
            _save(key, {'phase': 'logged_in', 'email': email})
        return output

    # ── 已登录：发帖/回复/跳过 ──────────────────────────────────────
    if phase == 'logged_in':
        if msg in ('跳过', 'skip', '取消'):
            _clear(key)
            return '好的，下次 /huoke 再见！👋'
        if msg.lower().startswith('r '):
            parts = msg.split(None, 2)
            idx = parts[1] if len(parts) > 1 else ''
            reply = parts[2] if len(parts) > 2 else ''
            return _run(f'--action "r {idx}" --reply "{reply}"')
        return _run(f'--action "{msg}"')

    # ── 未知状态 → 重新开始 ─────────────────────────────────────────
    _clear(key)
    output = _run('')
    _save(key, {'phase': 'awaiting_email'})
    return output


# ─── 1. /huoke 命令 ─────────────────────────────────────────────────────
def handle_huoke(raw_args: str) -> str:
    """
    register_command 签名: fn(raw_args: str) -> str | None
    CLI 模式用固定 key "_cli"
    """
    msg = raw_args.strip() if raw_args else ''

    if not msg:
        # 进入模式
        result = _process('_cli', '')
        return result + '\n\n💡 输入 exit 退出 huoke 模式'

    return _process('_cli', msg)


# ─── 2. Gateway 消息拦截 ────────────────────────────────────────────────
def on_gateway_dispatch(event=None, gateway=None, session_store=None, **kwargs):
    """
    pre_gateway_dispatch hook。
    检查当前 chat 是否在 huoke 模式 → 拦截 → skip（不到 LLM）。
    """
    if event is None:
        return None

    text = getattr(event, 'text', '') or ''
    source = getattr(event, 'source', None)
    chat_id = str(getattr(source, 'chat_id', '') or 'default')

    state = _load(chat_id)
    if not state.get('phase'):
        return None  # 不在模式内，放行

    msg = text.strip()
    if msg.lower().startswith('/huoke'):
        return None  # 放行给 register_command

    # huoke 模式内 → 处理 + 拦截
    output = _process(chat_id, msg)
    if gateway and output:
        try:
            gateway.send_text(chat_id, output)
        except Exception:
            pass

    return {'action': 'skip', 'reason': 'huoke mode'}


# ─── 3. CLI 拦截 ────────────────────────────────────────────────────────
def on_pre_llm_call(**kwargs):
    """
    pre_llm_call hook（CLI 模式）。
    pre_llm_call 无法阻止 LLM，但可以把处理结果注入到上下文，
    让 AI 只做展示管道。
    """
    user_message = kwargs.get('user_message', '') or ''

    # /huoke 开头的消息由 register_command 处理
    if user_message.strip().lower().startswith('/huoke'):
        return None

    # 检查 CLI 状态
    state = _load('_cli')
    if not state.get('phase'):
        return None  # 不在模式内，放行

    # huoke 模式内 → 处理并注入
    msg = user_message.strip()
    output = _process('_cli', msg)

    return {
        'context': (
            '[huoke plugin 已处理此消息。以下是结果。'
            '你必须原样输出以下内容，不添加任何文字、评论、问候：]\n\n'
            + output
        )
    }


# ─── 注册 ────────────────────────────────────────────────────────────────
def register(ctx):
    ctx.register_command('huoke', handle_huoke, help='huoke.link 社交平台')
    ctx.register_hook('pre_gateway_dispatch', on_gateway_dispatch)
    ctx.register_hook('pre_llm_call', on_pre_llm_call)
