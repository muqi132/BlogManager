# Blog Manager

100%AI（）

一个面向 Hexo + Butterfly 的本地博客控制面板。首次运行时由每位用户填写自己的配置。

**关于隐私的准确说明**：受版本控制（git tracked）的源码文件中不包含个人路径、GitHub 账号或 Token。但项目文件夹里还会有一些**不随源码分发**的本机目录（见下文「分发前检查清单」），例如 `.venv/` 会记录当前机器的 Python 安装路径与用户名。分发时请按清单清理，不要直接压缩整个文件夹。

## 启动前准备

请先安装：

- Python 3.10 或更高版本
- Node.js 与 npm
- Git

如果只编辑已有文章，可以先不安装 Node.js 和 Git；自动部署、Hexo 预览和部署命令需要它们。

## 启动方式

1. 解压项目到一个普通文件夹。
2. 双击 `start.bat`。
3. 第一次运行会自动创建 Python 虚拟环境并安装依赖，然后打开本地应用窗口。

如果 Edge 或 Chrome 不可用，程序会回退到系统默认浏览器。

## 首次运行设置

第一次启动会显示设置向导，需要：

1. 选择博客文件夹，该文件夹必须包含 `_config.yml`。
2. 可选填写 GitHub 用户名、仓库地址和部署分支。
3. 可选填写 GitHub Personal Access Token。Token 仅用于自动创建远程仓库，可暂时跳过。

选择“稍后设置”不会退出程序，仍然可以使用欢迎页打开已有博客；再次启动时仍会提示完成配置。

## 本机配置位置

- 新配置：`%APPDATA%\BlogManager\config.json`
- 旧版本配置：如果存在 `%APPDATA%\BlogManager\settings.json`，程序会优先迁移到 `config.json`，随后删除旧文件。

`config.json` 包含博客路径、最近目录、用户偏好和可选的 GitHub Token。请不要把该文件发送给别人。Token 采用明文存储，请谨慎使用；界面不会回显已保存的 Token。

## 常用功能

- 站点配置与 Butterfly 主题配置编辑，复杂字段支持 YAML 模式
- 文章树、搜索、新建、编辑、删除和 front-matter 修复
- 内置 Markdown 编辑器与 KaTeX 实时公式预览
- `source/img` 图片预览、缩放、旋转、重命名和封面设置
- 本地预览：`hexo clean` → `hexo generate` → `hexo server -p <端口>`
- 一键部署：`hexo clean && hexo deploy`
- 仅本地自动部署，或配置 GitHub 仓库后发布
- 自动部署时配置 Butterfly MathJax，支持行内和块级 LaTeX 公式

## 分发给别人

**受版本控制的源码可以安全分发**：`app.py`、`static/`、`templates/`、`start.bat`、`package.bat`、`requirements.txt`、`README.md` 等文件不含个人路径、账号或 Token。

但**不要直接压缩整个项目文件夹**。以下内容不受版本控制、不会随源码分发，却可能包含本机信息：

- `.venv/` —— 虚拟环境，其中的 `pyvenv.cfg` 记录了当前机器的 Python 安装路径与 Windows 用户名
- `.userdata/`、`.deps/`、`.testblog/` —— 运行期缓存与测试用目录
- `config.json`、`settings.json` —— 用户配置，**含明文 GitHub Token**
- `.blogmanager-trash/` —— 回收站，含你删除过的文章正文
- `*.blogmanager.bak`、`*.blogmanager.tmp` —— 编辑文章/配置时留下的备份与临时文件
- `logs/` 与 `*.log` —— 运行日志，含绝对路径与命令输出
- `dist/` —— 打包产物
- `__pycache__/`、`*.pyc` —— Python 编译缓存

### 推荐方式：使用打包脚本

若要生成排除上述内容的 ZIP，在项目根目录双击 `package.bat`：

```bat
package.bat
```

生成文件位于 `dist/BlogManager_YYYYMMDD.zip`。脚本会排除 `.venv`、`.git`、`node_modules`、`dist`、`__pycache__`、`.e2e-yaml-probe`、`.userdata`、`.deps`、`.testblog`、`.blogmanager-trash`、`config.json`、`settings.json`、`*.blogmanager.bak`、`*.blogmanager.tmp`、`*.pyc`、`*.log`，并在压缩完成后再次扫描 ZIP；发现敏感文件时会删除压缩包并终止打包。

### 分发前检查清单

手工复制源码时，请逐项确认：

1. 删除 `.venv/`（接收方首次运行 `start.bat` 时会自己创建）
2. 删除 `.userdata/`、`.deps/`、`.testblog/`（如果存在）
3. 删除 `.blogmanager-trash/`（如果存在）
4. 确认没有残留的 `*.blogmanager.bak`、`*.blogmanager.tmp`
5. 确认没有残留的探针脚本或一次性测试目录（如 `.e2e-*`、`_probe*.py`、`_audit*.py`）
6. 确认没有 `config.json`、`settings.json`、`logs/`
7. 确认没有 `dist/` 里的旧压缩包

**注意**：如果仓库曾经提交过 `.venv/pyvenv.cfg` 之类的文件，仅删除工作区文件并不够，历史提交里仍然保留；公开托管前请先检查历史（见下）。

## 常见问题

### 启动后没有窗口

确认 Python 已加入 PATH，并可运行 `python --version`。然后重新双击 `start.bat`。

### 自动部署提示找不到 Node.js、npm 或 Git

安装缺少的工具，重新打开命令行让 PATH 生效，然后重新启动 Blog Manager。

### GitHub Token 提示无效或权限不足

Token 需要具备创建仓库的权限。也可以不自动创建仓库，改为在 GitHub 手动创建后填写仓库地址。

### 端口被占用

控制面板会自动推荐其他端口，也可以在本地预览卡片中修改端口。

### 如何反馈问题

请提供：

- 操作系统版本
- Python、Node.js、Git 版本（如果相关）
- 操作步骤
- 界面错误提示或日志中的关键行

请先删除日志和截图中可能出现的个人路径、用户名、仓库地址或 Token。

## 清理本机配置

欢迎页底部提供“清理本地配置”按钮。清理后不会删除博客文章和图片，只会删除本机 `config.json`，下次启动重新进入首次设置。
