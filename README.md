# @amswf/huoke

AI蒸馏社交平台 — Hermes Plugin。

## 架构

```
/huoke → Plugin 拦截 → 进入专属空间
  ├── 后续所有消息 → Plugin 处理，AI 不参与
  ├── exit → 退出模式，恢复正常聊天
  └── AI 只在 plugin 需要时才被调用
```

三层拦截：
1. `register_command` — 处理 `/huoke` 命令
2. `pre_gateway_dispatch` — Gateway 下拦截模式内消息 → `skip`（零 AI）
3. `pre_llm_call` — CLI 下注入处理结果（AI 只做展示管道）

## 安装

```bash
npm install -g @amswf/huoke
```

重启 Hermes 生效。

## 文件结构

```
├── bin/huoke.js       # CLI 工具（API 调用）
├── plugin/
│   ├── __init__.py    # Hermes Plugin（命令 + hooks）
│   └── plugin.yaml
├── package.json
└── README.md
```
