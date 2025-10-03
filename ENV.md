# 前端开发环境搭建指南

## 1. 前置要求
- Node.js >= 18.x (LTS)
- Git 已安装
- 推荐 IDE：VS Code（或 WebStorm）
  - VS Code 推荐插件：
    - ESLint
    - Prettier
    - Highlight Matching Tag
    - Live Server (可选)
    - Path Intellisense

## 2. Clone 仓库
```bash
git clone https://github.com/gasry1989/MyFile.git
cd MyFile
```

## 3. 创建目录并粘贴代码
把回答中提供的所有文件按结构建立（index.html, main.js, styles/, modules/, bootstrap/, config/ 等）。

## 4. 启动本地静态服务器
方式一：使用任意裸 HTTP 服务器（推荐 npx serve）
```bash

$ node -v
v20.19.5

Admin@DESKTOP-gary MINGW64 /g/JavaPrj
$ npm -v
10.8.2


npm init -y              # 仅第一次
npm install serve --save-dev
npx serve .              # 默认 3000 端口
# 浏览器访问 http://localhost:3000
```

方式二：使用 VS Code 插件 “Live Server”
- 右键 index.html -> Open with Live Server
