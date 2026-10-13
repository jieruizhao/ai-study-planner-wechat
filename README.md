# 知学计划 · AI 备考与学习规划助手

**[体验小程序](https://open.weixin.qq.com/sns/getexpappinfo?appid=wx1113286b7b45c357&path=#wechat-redirect)**

请使用微信打开体验入口；体验版是否可访问取决于微信平台的版本状态和体验成员权限。

面向 **雅思 IELTS、大学英语四六级 CET-4 / CET-6、考研和日常自学** 的微信小程序学习助手。把备考计划、专注计时、学习打卡、习惯养成和统计复盘放在一起，并通过 Coze（扣子）AI 学习导师，根据真实学习记录生成可编辑、可导入、可撤销的建议计划。

**AI Study Planner for WeChat** — study tracking, focus timer, habit tracking and AI-assisted exam preparation, built with JavaScript, Tencent CloudBase and Coze.

[快速开始](#快速开始) · [部署指南](docs/DEPLOYMENT.md) · [架构设计](docs/ARCHITECTURE.md) · [安全说明](SECURITY.md)

## 适合哪些学习场景？

| 场景 | 可以怎样使用 |
| --- | --- |
| 雅思 IELTS 备考 | 拆分听力精听、阅读练习、词汇复习和写作任务，记录卡点，按周复盘学习时长。 |
| 大学英语四级、六级 CET-4 / CET-6 | 安排真题、听力、阅读和翻译练习，通过学习日历查看每天的实际完成情况。 |
| 考研备考 | 按英语、政治、数学或专业课建立任务，设置考试日期并跟踪投入时间。 |
| 日常自学与习惯养成 | 管理阅读、技能练习和复习习惯，结合历史记录调整下一阶段计划。 |

以上是使用示例；项目提供通用学习管理和 AI 规划能力，不包含内置题库、自动判分或提分保证。

## 从记录到下一步计划

1. 设置考试日期、可学习日与每日任务，或用 Excel 导入已有计划。
2. 开始专注计时，保存实际学习时长、遇到的问题和下一步行动。
3. 选择近 7 天、近 30 天或自定义日期，查看统计并请求 AI 分析。
4. 编辑建议、确认导入日历；需要调整时可撤销导入并保留已使用的项目。

如果这个项目对你有帮助，欢迎 **Star 收藏**；遇到问题或有场景建议，可以在 Issues 中反馈，请勿提交个人学习数据或密钥。

## 功能

- 今日任务卡片左右滑动、专注暂停与继续、学习记录编辑和长文本备注。
- 学习日历、日期任务维护、习惯打卡、一次性微信订阅与手机日历提醒。
- Excel 任务导入与学习记录导出，微信账号资料和账号数据隔离。
- 最近 7 天、30 天及自定义日期统计。
- Coze 学习导师：结合区间内时长、任务和备注提出学习与习惯计划。
- 建议预览编辑、事务导入、重复提交保护和保留已使用项的撤销。
- 分析历史与导入历史管理、超时错误提示及已保存结果恢复。

## 架构

```mermaid
flowchart LR
  UI[微信小程序] --> API[api 云函数]
  API --> DB[(云数据库)]
  API --> Agent[studyAgent 云函数]
  Agent --> Coze[Coze 工作流]
  Scheduler[scheduler 定时云函数] --> DB
  Scheduler --> WeChat[微信订阅消息]
```

统计由服务端计算，AI 只解释记录并生成建议。模型不能直接写数据库；建议经过日期、时长、预算和重复项校验，需用户确认后导入。撤销保留已完成、已修改或已有学习记录的项目。

| 目录 | 内容 |
| --- | --- |
| `miniprogram/` | 页面、样式、图标和本地同步逻辑 |
| `cloudfunctions/api/` | 业务入口、微信身份检查、数据隔离与事务 |
| `cloudfunctions/studyAgent/` | 导师提示词及 Coze 调用桥接 |
| `cloudfunctions/scheduler/` | 提醒检查及订阅消息发送 |
| `tests/` | 静态检查与模拟业务回归 |

## 快速开始

1. 使用微信开发者工具打开项目，将 `project.config.json` 中的 `touristappid` 换成你自己的 AppID。
2. 将 `miniprogram/app.js` 中的 `YOUR_CLOUD_ENV_ID` 换成自己的云环境 ID。
3. 按 [部署说明](docs/DEPLOYMENT.md) 配置并部署云函数。
4. 本地安装 Node.js 22 或更新的兼容版本，执行：

```sh
npm install
npm test
npm run check
```

GitHub Actions 执行相同的回归与静态检查。测试使用模拟数据，不调用付费模型、不发送微信消息。云端权限、真实模型响应及手机交互仍需在自己的环境验收。

## 公开源码范围

本仓库从最新项目生成独立的公开副本，保留核心功能源码，部署配置使用占位值。未包含真实密钥、生产云环境 ID、Coze 部署地址/项目编号、个人学习记录、个人开发者配置、部署截图和原项目 Git 历史。

README 顶部的体验 AppID 是体验入口必需的公开标识，经项目所有者授权保留；它不是密钥。请勿把生产配置写入源码或提交到 Git。

更多设计与限制见 [架构说明](docs/ARCHITECTURE.md) 与 [安全说明](SECURITY.md)。
