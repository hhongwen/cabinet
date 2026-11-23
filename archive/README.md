# 旧版 Cabinet（已归档）

这里是从仓库根目录移进来的旧代码，2026-11-23 归档。

**不要在这里改东西。** 它不参与任何构建，也不会被运行。
保留的原因只有一个：`NOTES.md` 里那 19 条跨平台踩坑记录还有引用价值。

## 里面是什么

```
bin/                 CLI 入口
src/                 中台、队列、调度器、任务存储、飞书桥
examples/            20 个测试脚本（含假 agent 与端到端）
public/              旧面板（jobs.html 更早的三栏版）
GOAL.md              目标定义：任务编排器，不是 Agent
DESIGN.md            实现方案
NOTES.md             实现笔记 + 19 条平台踩坑
HANDOFF.md           交接文档
rules.json           规则示例
cabinet.config.json  运行配置
package.json         当时的包描述
```

## 它做到了什么

飞书发一句话 → 建任务 → LLM 拆解 → 调度器起 codex → 结论回群 →
卡片审批 → 点完按钮原地变样子。这条链路是真的通的。

## 为什么停

这套系统想做的事（事件触发 Agent 自己干活）已经是平台自带能力，
继续写等于给已经铺好的公路再修一条小径。

完整说明见 [../ARCHIVED.md](../ARCHIVED.md)。

## 现在还值钱的

1. **`NOTES.md` 的 19 条坑** —— 已提炼成
   `~/.config/alma/skills/win-gitbash-agent-automation/SKILL.md`
2. **`rules.json` 的规则写法** —— 事件 → agent / 目录 / 模型 / 是否要批
3. **任务表设计** —— `tasks / task_runs / task_deps / timeline`，
   每次状态变化都能追溯到一条记录
