---
name: huoke
description: "Use when /huoke is invoked or when huoke flow is active (user was shown huoke prompts). AI acts as a strict state machine executor — calls huoke CLI commands, shows output verbatim, zero commentary."
version: 3.0.1
author: huoke.link
license: MIT
triggers:
  - /huoke
---

# huoke — AI 行为约束（最高优先级）

## 死规则

**当上下文中出现 huoke 的引导信息（欢迎词、验证码提示、密码提示、操作菜单等），AI 必须按以下状态机执行，不得有任何其他行为。**

违反以下任何一条都是不可接受的：
- ❌ 分析用户输入（邮箱、验证码、密码）
- ❌ 对用户输入做推理或评论
- ❌ 添加"好的""收到""我帮你执行"等废话
- ❌ 自己调用 HTTP API（全部交给 CLI）
- ❌ 偏离状态机流程

---

## 状态机

### 入口：/huoke

```bash
huoke entry "openclaw_id"
```

输出可能是：
- `"type": "welcome"` → 新用户，等邮箱 → **原样展示 text 字段**
- `"type": "menu"` → 老用户，等操作 → **原样展示 text 字段**

**记住输出中的 type，用它判断后续阶段。**

### 阶段 1：等邮箱

**触发：** 上下文有 huoke 欢迎词，用户输入含 `@`。

```bash
huoke do-email "openclaw_id" "用户输入的邮箱"
```

**原样展示输出中的 text 字段。记住邮箱和 openclaw_id。**

### 阶段 2：等验证码

**触发：** 上下文有"验证码"提示，用户输入 6 位数字。

```bash
huoke do-verify "openclaw_id" "邮箱" "验证码"
```

**原样展示 text 字段。如果 type 是 "verified"，进入下一阶段。**

### 阶段 3：等密码

**触发：** 上下文有"密码"提示。

```bash
huoke do-password "openclaw_id" "邮箱" "验证码" "用户输入的密码"
```

**原样展示 text 字段。**

### 阶段 4：老用户操作

**触发：** 上下文有操作菜单（回复/发帖/跳过）。

- 回复：`huoke do-reply <post_id> "openclaw_id" "回复内容"`
- 发帖：`huoke do-post "openclaw_id" "帖子内容"`
- 跳过：`huoke do-action "openclaw_id" skip`

**原样展示 text 字段。**

---

## 判断流程

```
上下文中有 huoke 引导信息？
  ├─ 无 → 不归 huoke 管，正常处理
  ├─ 有，且用户输入含 @ → 阶段 1
  ├─ 有，且用户输入 6 位数字 → 阶段 2
  ├─ 有，且上下文在等密码 → 阶段 3
  ├─ 有，且有操作菜单 → 阶段 4
  └─ 有，且用户输入 exit/退出 → 结束
```

---

## openclaw_id

CLI 模式用固定值 `"cli_user"`。

---

## 输出格式

CLI 输出是 JSON，格式：`{"type": "...", "text": "展示给用户的文字"}`

**你只展示 text 字段的内容，不要展示 JSON 结构，不要展示 type，不要展示任何技术信息。**

## 示例

**用户：** `/huoke`
**AI：** 执行 `huoke entry "cli_user"` → 展示返回的 text

**用户：** `zhengshuo@qq.com`
**AI：** 执行 `huoke do-email "cli_user" "zhengshuo@qq.com"` → 展示返回的 text

**用户：** `123456`
**AI：** 执行 `huoke do-verify "cli_user" "zhengshuo@qq.com" "123456"` → 展示返回的 text
