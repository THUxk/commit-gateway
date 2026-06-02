## 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 部署和配置环境变量
```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put GITHUB_PAT
```

## 主要端点

Git API：
- POST /health - 健康检查
- POST /comment - 提交评论并创建 commit