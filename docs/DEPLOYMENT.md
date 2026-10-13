# 部署说明

需要自己的微信小程序账号、云开发环境，以及已发布为 API 的 Coze 工作流。仓库中的示例配置不会自动设置云端环境变量。

## 微信与云开发

填写自己的 AppID 和云环境 ID，在开发者工具的云函数根目录选择该环境。部署 `api` 和 `scheduler`，选择云端安装依赖；`studyAgent` 仅使用 Node.js 内置模块。`api`、`studyAgent` 的执行超时设置为 60 秒。

`scheduler/config.json` 提供每分钟触发器，部署后还需在开发者工具右键该函数上传触发器。订阅消息配置位于 `configs` 集合的 `key: subscribe` 记录，包含自己的 `templateId`；数据映射按选用模板实际字段配置。一次订阅只能发送一次，不承诺消息必达。

选择文件、头像等隐私接口需在微信后台申报实际用途，并完成用户隐私授权流程。

## Coze 工作流

开始节点接收两个字符串：`system_prompt` 与 `input`。系统提示使用 `cloudfunctions/studyAgent/prompt.js`；用户输入是学习统计、截取后的记录和计划设置的 JSON 字符串。

结束节点返回 `output` 对象或其 JSON 字符串，字段为：

```json
{
  "strengths": "依据记录说明做得好的地方",
  "difficulties": "依据记录说明困难和数据局限",
  "suggestions": "可持续的学习节奏建议",
  "tasks": [],
  "habits": []
}
```

任务项包含 `date`、`subject`、`content`、`minutes`、`reason`；习惯项包含 `name`、`weekdays`、`reason`。日期、星期和每天总时长须遵守输入中的 `settings`，预算包含原有任务。单次最多 20 条任务和 7 个习惯。

Coze 编程工作流配置自己的 `https://YOUR_PROJECT.coze.site/run` 地址，直接 POST 两个入参；低代码工作流则使用工作流 ID。两种调用协议不同，项目编号不能当作工作流 ID。

| 云函数 | 环境变量 |
| --- | --- |
| `api` | `STUDY_AGENT_BRIDGE_SECRET` |
| `studyAgent` | 相同的 `STUDY_AGENT_BRIDGE_SECRET`、`COZE_API_TOKEN`、`COZE_API_URL`；仅低代码模式填写 `COZE_WORKFLOW_ID` |

桥接密钥使用高强度随机值，实际令牌只保存在云端。不要直接部署占位值。执行模型调用和托管服务可能消耗平台额度，部署者应自行检查计费与用量。

## 数据与验收

`api` 首次有效调用会初始化业务集合，初始化不等于权限已配置。按仅服务端读写配置集合权限，并核对账号隔离；不要开放公共写入。客户端只通过业务 API 访问数据。

真机验收：登录、同步记录、生成分析、编辑建议、导入、重复提交、撤销、删除历史、切换账号，以及超时/断网后的结果确认。测试应使用自己创建的演示数据。
