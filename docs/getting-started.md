# 本地应用使用说明

## 环境要求

- Node.js 22 或更高版本
- npm 10 或更高版本
- Git
- OpenAI API Key

## 启动

```bash
cp .env.example .env
```

在 `.env` 中填写 `OPENAI_API_KEY`。应用不会把密钥保存到 SQLite 或前端。

如果使用兼容 OpenAI API 的中转平台，还需要按照平台文档填写：

```bash
OPENAI_BASE_URL=https://中转平台提供的API根地址/v1
OPENAI_API_MODE=responses
OPENAI_MODEL=中转平台支持的模型ID
```

中转平台支持 OpenAI Responses API 时使用 `OPENAI_API_MODE=responses`；只兼容 Chat Completions（`POST /v1/chat/completions`）时使用 `OPENAI_API_MODE=chat`。两种模式都要求平台支持 JSON 结构化输出。

```bash
npm install
set -a && source .env && set +a
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。API 监听 `http://127.0.0.1:3210`。

## 接入 Soto Dine

进入“项目”，使用以下配置：

- 项目名称：`Soto Dine`
- 仓库路径：`/Users/whp/Documents/workspace/haini-workspace/soto-dine`
- 默认分支：`prod`
- Maven 白名单：`mvn test -pl dine-service/dine-product-service`

登记项目只验证仓库，不修改代码。编码阶段创建独立分支和 worktree；应用不会自动提交、合并或推送。

## 数据

- SQLite：`data/workflow.db`
- 备份：`data/backups/`
- 本地数据目录已经加入 `.gitignore`。

首次试用建议创建“统一订单备注校验”，并按产品 PRD、研发评审、技术设计、编码、Review、测试和验收顺序逐阶段手动启动 AI。
