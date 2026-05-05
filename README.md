# Gopeed 夸克网盘下载扩展

Gopeed 扩展，用于解析夸克网盘分享链接并下载文件。

## 项目结构

```
gopeed-extension-quark/
├── index.js          # 源码
├── dist/
│   └── index.js      # 打包后的文件
├── package.json      # 依赖配置
├── webpack.config.js # 打包配置
├── manifest.json     # 扩展配置
└── README.md         # 说明文档
```

## 打包

```bash
npm install
npm run build
```

## 安装

### 方法 1: 通过 Gopeed 扩展商店安装

1. 打开 Gopeed
2. 进入「扩展」页面
3. 搜索「夸克网盘」或输入仓库地址
4. 点击安装

### 方法 2: 本地安装

1. 下载本扩展的所有文件到一个文件夹
2. 打开 Gopeed
3. 进入「扩展」页面
4. 点击「安装本地扩展」(连点下载图标5次)
5. 选择包含 `manifest.json` 的文件夹

## 配置

### 夸克 Cookie

1. 使用浏览器访问 [https://pan.quark.cn/](https://pan.quark.cn/)
2. 登录你的夸克账号
3. 按 `F12` 打开开发者工具
4. 切换到 `Network` 标签页
5. 找到 list 请求，复制 `Request Headers` 中的 `Cookie` 值
6. 在 Gopeed 扩展设置中粘贴

## 支持的链接格式

- 标准分享链接: `https://pan.quark.cn/s/xxxxxxxxx`
- 带密码的分享: `https://pan.quark.cn/s/xxxxxxxxx?pwd=1234`
- 带目录的分享: `https://pan.quark.cn/s/xxxxxxxxx#/list/share/folderid`

## 功能特性

### 事件处理

- **onResolve**: 解析链接，获取文件列表和下载直链
- **onStart**: 下载开始时检查链接是否过期，自动刷新（此方法来自 [foxxorcat@gopeed-extention-quarkuc](https://github.com/foxxorcat/gopeed-extention/tree/main/gopeed-extention-quarkuc)）

### __puus 自动刷新

夸克网盘会定期刷新 `__puus` cookie 值。本扩展使用 superagent 库，每次请求后自动检查响应头中的 `set-cookie`，如果包含 `__puus` 则自动更新。这可以避免长时间使用时 Cookie 失效的问题。

### 分页解析

自动分页获取文件列表，支持超大文件夹（超过 1000 个文件）。

### 智能分块转存

根据网盘可用空间，自动将文件分批转存，支持"边存边删"模式。

## 致谢

- [foxxorcat](https://github.com/foxxorcat) - onStart 链接刷新机制、__puus 刷新机制
- 小米 MiMo - AI 代码助手

## 常见问题

### 1. 提示「未配置 Cookie」

请确保已在扩展设置中正确配置夸克 Cookie。

### 2. 提示「Cookie 已失效」

Cookie 已过期，需要重新登录夸克网盘并获取新的 Cookie。

### 3. 提示「触发 23018 限制」

夸克对大文件下载的限制。本扩展已使用 PC 端的 User-Agent 绕过此限制。

### 4. 下载速度慢

下载速度取决于：
- 你的夸克账号类型（普通/会员）
- 你的网络状况
- 夸克服务器的限速策略

建议下载连接数设置为 `256`。

## 免责声明

本扩展仅供学习交流使用，项目中所涉及的接口均来自夸克官方。需要使用自己的夸克网盘账号才能获取下载链接。代码全部开源，请勿用于商业用途。

## 开源协议

MIT License
