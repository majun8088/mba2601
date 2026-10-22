# MBA 2601 课程日程表 - Cloudflare Pages 部署指南

## 项目结构

```
mba-schedule/
├── index.html              # 主页面
├── functions/
│   └── proxy.js            # CF Pages Functions 代理（绕过 CORS）
└── README.md
```

## 部署步骤

1. 将整个 `mba-schedule/` 目录推送到 GitHub / Gitee 仓库
2. 登录 [Cloudflare Pages](https://pages.cloudflare.com/)，点击 "Create a project"
3. 连接你的 Git 仓库
4. 构建设置：
   - **Framework preset**：None
   - **Build command**：留空
   - **Build output directory**：`.`
   - **Root directory**：留空（默认）
5. 点击 "Save and Deploy"

## 工作原理

```
浏览器 → your-site.pages.dev/proxy?url=远程ICS地址 → CF Function → 远程 ICS 服务器
```

- 前端通过 `/proxy?url=` 请求自己的域名，属于同源请求，无 CORS 问题
- CF Function 在服务器端抓取远程 ICS 文件并返回
- 远程 ICS 地址更新后，刷新页面即可获取最新课表

## 更新课表流程

1. 更新远程 ICS 文件内容（如 Gitee 仓库中的 MBA2601.ics）
2. 打开网页，点击右上角齿轮图标
3. 确认 ICS 地址正确，点击"重新加载"
4. 全班刷新页面即可看到最新课表

## 注意事项

- CF Pages Functions 免费计划每天 10 万次请求额度，课表场景完全够用
- 如果 ICS 地址变更，在设置面板中修改即可，无需重新部署
- Functions 做了安全限制：仅允许 http/https 协议，防止被滥用为开放代理
