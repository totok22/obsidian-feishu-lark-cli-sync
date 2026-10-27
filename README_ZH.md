# 飞书文档发布器 (Feishu Docs Publisher)

[English](./README.md) | 简体中文

通过本机 `lark-cli`，把 Obsidian 里的 Markdown 笔记、目录和 PDF 发布到飞书 / Lark 云文档，并保持同步。

内容以 Obsidian 为准，团队在飞书 / Lark 里阅读和评论。同步是单向的。笔记首次发布后会和文档绑定，之后的同步直接更新这篇文档。

需要 Obsidian 1.13.0 或更高版本（仅桌面端）、一个飞书或 Lark 账号，以及 Node.js 和 npm。`lark-cli` 由插件替你安装。笔记通过 `lark-cli` 上传，详见[网络与第三方账号披露](#网络与第三方账号披露)。

[快速开始](#快速开始) · [使用指南](#使用指南) · [设置一览](#设置一览) · [同步原理](#同步原理) · [常见问题](#常见问题) · [迁移](#从-feishu-lark-cli-sync-迁移) · [开发与发布](#开发与发布)

---

## 快速开始

### 1. 安装插件

用过旧插件「Feishu Lark CLI Sync」的话，先看[迁移说明](#从-feishu-lark-cli-sync-迁移)。

**社区插件**（上架后）：打开 **设置 → 社区插件**，关闭安全模式，点「浏览」，搜索 `Feishu Docs Publisher`，「安装」并「启用」。

**从 Release 安装**：到 [GitHub Releases](https://github.com/totok22/feishu-docs-publisher/releases) 下载 `main.js`、`manifest.json` 和 `styles.css`，放进 `<库>/.obsidian/plugins/feishu-docs-publisher/`，重新加载社区插件并启用。Git hook 脚本已经嵌在 `main.js` 里，不需要别的文件。

**从源码构建**：

```bash
git clone https://github.com/totok22/feishu-docs-publisher.git
cd feishu-docs-publisher
npm install
npm run build
./install.sh "/path/to/your/vault"
```

脚本会把构建结果复制到库的插件目录；如果该库已经安装过本插件的 hook，也会刷新 hook 辅助脚本。重启 Obsidian 后启用插件。

### 2. 连接账号

打开 **设置 → Feishu Docs Publisher → CLI 与授权**，不需要打开终端。

1. 没有 npm 的话，点「下载 Node.js」，装好后点「重新检测」。
2. 点「安装 lark-cli」。以后有新版本，还是这个按钮来升级。
3. 仅首次使用：在「CLI 应用配置」选飞书或 Lark，点「创建应用」，在浏览器里走完官方流程。
4. 点「登录 / 重新授权」，在浏览器确认权限。要换账号，先「退出登录」再重新登录。

`lark-cli` 版本必须高于 1.0.53。版本过低可能让新文档的标题变成 `Untitled`，或者同步时报错，设置页会提示升级。自动探测不到可执行文件时，在「lark-cli 路径」里填绝对路径。

需要代理的话，「网络代理」默认沿用系统的 `HTTPS_PROXY`、`HTTP_PROXY` 或 `ALL_PROXY`，也可以填自定义 HTTP 代理（如 `127.0.0.1` 和 `7890`），或者关闭代理。它只作用于本插件启动的 `lark-cli`、npm 和 Git `pre-push` 进程，不会保存代理的用户名和密码。

### 3. 发布第一篇笔记

1. 可选：在 **设置 → 常规 → 默认上传位置** 填 Wiki URL、Wiki 节点 token 或文件夹 token。留空则发到个人文档库。
2. 右键一篇笔记，选 **Lark: 同步到飞书**。命令面板里也有「同步到飞书」，对当前打开的笔记生效。
3. 新文档会在浏览器里打开，标题默认是文件名，可以用「标题来源」改。
4. 改完笔记再同步一次，就会更新同一篇文档。默认设置下，已发布的笔记保存约 15 秒后也会自动同步，见[自动同步](#自动同步)。

---

## 使用指南

### 速查表

在笔记、PDF 或文件夹上右键即可。同步、覆盖同步、打开链接、已发布文件和选择忽略的文件，命令面板里也有。

| 我想… | 怎么做 |
| --- | --- |
| 发布或更新一篇笔记 | 右键笔记 → `Lark: 同步到飞书` |
| 发布整个文件夹并保留层级 | 右键文件夹 → `Lark: 同步到飞书` |
| 上传 PDF | 右键 PDF → `Lark: 同步到飞书` |
| 让远端和本地完全一致，并清掉同名重复文档 | `Lark: 覆盖同步到飞书` |
| 把笔记、PDF 或文件夹绑定到已有的文档 | `Lark: 设置飞书链接` |
| 打开某个文件对应的飞书页面 | `Lark: 打开飞书链接` |
| 查找或复制已发布的链接 | 左侧栏纸飞机图标 → 「已发布文件」 |
| 让文件夹同步跳过一部分文件 | 右键文件夹 → `Lark: 选择忽略的文件` |
| 编辑后自动同步 | **设置 → 同步 → 自动同步方式** |

### 同步与覆盖

同步：笔记第一次是发布，之后是更新。覆盖：用本地内容重写远端，并删除同一远端目录里其他同名文档。两者都适用于笔记、PDF 和文件夹。

首次发布会把笔记和文档绑定，绑定保存在插件数据中。打开「写入 frontmatter 绑定信息」（默认关闭，升级时保留你已保存的选择）后，链接也会写进笔记：

```yaml
---
lark_doc_url: "https://example.feishu.cn/docx/xxxx"
---
```

一个远端文件只能绑定一个本地文件。设置链接、恢复绑定和同步前都会检查这一点，已有共享绑定要先改掉。

覆盖同步的规则：

- 保留已绑定的文档。没有绑定时，先选一篇同名文档，保存绑定并确认本地内容已写入，再删除同一远端目录里的其他同名文档。
- 普通同步、保存后同步和 Git hook 都不会删除重复文档。已被另一个本地文件绑定的文档也不会被删。
- 要删除的重复 Wiki 文档如果有子页面，会先把子页面移到保留的文档下。
- 目录覆盖会处理其中所有 Markdown 和 PDF，并把目录页重置为子页面列表。同一目录下两篇笔记的文档标题相同时会停下，请先改名。

### 图片与视频

笔记里的本地图片和视频会随笔记一起上传。

```md
![[diagram.png]]
![[diagram.png|600]]
![[diagram.png|600x400]]
![架构图](../assets/diagram.png)
![架构图|600](../assets/diagram.png)
![架构图|600x400](../assets/diagram.png)
![[clip.mp4]]
![演示](../assets/clip.mp4)
```

- 图片：支持 PNG、JPEG/JPG、GIF、WebP 和 BMP，必须在当前库内。HTTP(S) 图片走普通的 Markdown 导入。
- 本地图片的 `|600` 表示宽度为 600 像素，高度按原图比例计算；`|600x400` 指定宽高，也支持 `×` 分隔。尺寸后缀不会作为图注，`![架构图|600](...)` 的图注为“架构图”。
- 视频：支持 MP4、M4V、MOV 和 WebM，显示为文件预览块。能否播放取决于编码和客户端，已实测 H.264/AAC 的 MP4 和 MOV。远程视频地址和普通链接不会上传。没变化的视频会复用。
- 只有被引用的图片或视频变化时，保存后同步和 `pre-push` 仍会同步引用它的已绑定笔记。

### Callout 折叠与科研配色

在 **设置 → 内容** 打开“原生 Callout 折叠”（默认关闭），再同步含 Callout 的笔记。标题会成为可折叠的父块，正文、嵌套 Callout、代码和本地媒体保留在对应子块中。`-` 表示初始折叠，`+` 表示初始展开。关闭时，尚未转换的 Callout 导出为带标题的普通引用。

```md
> [!note]- 实验细节
> 参数说明
>
> ![[diagram.png|320]]
```

**已有文档首次转换会重建正文**，文档链接保留，原有块评论和定位链接可能失效。安全增量策略会阻止已有文档的首次转换；需要迁移时，先合并远端改动，再用自动策略同步。关闭开关后，已转换的文档仍使用原生同步，避免再次改变结构。

转换后的同步会保留相同的前后顶层子树，更改 Callout 内的内容会重建所属顶层子树。读者展开或收起不算正文冲突；检测到飞书正文被修改时，同步会停止。标题只设置背景色，不复刻 Obsidian 的完整边框。

“科研标签配色”也是默认关闭的独立开关。开启后，原生导出会把冒号前的加粗标签设为红字、黄色背景，例如 `**结论**：结果稳定`。代码和普通粗体保持原样。原生导出需要 `docx:document.block:convert` 权限，暂不支持网络图片；单次变更超过 1,000 块时停止。详见[原生导出说明](./docs/native-export.md)。

### 同步目录

右键目录，选 `Lark: 同步到飞书`。插件会建好对应的远端层级，同步其中的 Markdown 和 PDF，并把笔记之间的链接改成指向远端文档。本地笔记不会被改动。

```md
详细设计见 02-database.md。
[组件设计](03-components.md#section)
[[04-api|接口设计]]
```

目标是 Wiki（`/wiki/...`）或个人文档库时，每一级目录本身也是文档，插件会在里面插入飞书 / Lark 原生的子页面列表。列表里的链接由飞书 / Lark 维护。普通目录同步会保留已有的列表和页面上的其他内容，目录覆盖则把页面重置为列表。Drive 目标（`/drive/folder/...`）用的是普通文件夹，没有列表。

没有被任何笔记引用的图片不会上传到飞书。目录同步会把它们收集到一篇自动生成的 `<目录名> 图片.md`，放在图片所在目录，并和其他笔记一样发布。每次目录同步都会刷新它。可以重命名，插件靠第一行的隐藏注释认出它。

想顺带清理你删除或移走的文件，打开「删除本地已不存在的飞书文件」（默认关闭）。目录同步成功后，插件会列出该目录下由它发布、但本地文件已不存在的飞书文档和 PDF，你确认后才会删除。

- 只处理有发布记录的文件，你在飞书里手动建的文档不会动。
- 在 Obsidian 之外移动的笔记，只要还有笔记链接到同一篇文档就会保留。下面还有子页面的 Wiki 文档会跳过。
- 本地一侧靠 Git 历史兜底，插件无法恢复已删除的远端文件。

### PDF

目录同步会把 PDF 作为原生文件上传到对应的 Drive 文件夹或知识库节点，也可以右键单个 PDF 上传。默认上传位置为空时，单个 PDF 传到 Drive 根目录。

笔记里可以这样引用 PDF：

```md
[[规格书/报告.pdf]]
![[规格书/报告.pdf]]
[[报告.pdf|查看规格书]]
![[报告.pdf#page=2]]
[查看规格书](规格书/报告.pdf)
```

上传完成后，目录同步会把这些引用改成飞书 / Lark 的原生文件引用。单篇首次发布、手动同步和保存后同步会复用已有的 PDF 绑定。PDF 不在同步目录里时，先单独上传，或绑定它的远端 URL。

普通 PDF 引用会转为可点击的原生文件引用，并保留别名、文件名和页码文字。未发布或未绑定的 PDF 会显示可读说明，并提示先发布或绑定；代码示例保持原文。同名文件的解析方式和 Obsidian 链接一致，精确选区跳转暂不支持。

PDF 页码嵌入和 PDF++ 区域嵌入会渲染成图片，保留页码图注和指定尺寸。示例：`![[报告.pdf#page=2|600]]`、`![[报告.pdf#page=2&rect=10,20,110,70|300]]`。在 Obsidian 中使用内置 PDF.js；Git hook 需要安装 Poppler（`pdfinfo` 和 `pdftoppm`），旋转页面请在 Obsidian 内发布。源 PDF 保持原样。

- 没变化的 PDF 会跳过，依据是绑定和内容哈希。内容变了就覆盖同一个远端文件，链接不变。本地重命名会保留绑定和远端文件名。
- PDF 只通过手动同步和目录同步更新，保存后同步和 Git hook 不处理。
- 覆盖会重新上传，即使 PDF 没变。没有绑定时先复用同名文件，上传成功后再删除同一远端目录里的其他同名 PDF。
- Git hook 能改写用库路径或相对笔记路径写的引用。其他目录里的短文件名要靠 Obsidian 解析，用 hook 时请写上路径。

上传超时的话，插件会保留一条待确认记录，不会自动重试。请先在 `Lark: 设置飞书链接` 里核对远端是否已有这个文件，再重试。确认没有创建远端文件的话，断开这条待确认记录后重新上传。

### 忽略文件和文件夹

想让部分笔记、PDF 或子文件夹不同步到飞书，用「同步忽略」页面：右键文件夹，选 `Lark: 选择忽略的文件`。「已发布文件」窗口、命令面板和 **设置 → 同步 → 同步忽略** 里也能进入。

页面把这个文件夹显示成一棵树。取消勾选就是忽略，重新勾选就恢复同步。取消勾选整个文件夹，里面所有内容都会被忽略，包括之后新增的文件；只有部分内容被取消勾选的文件夹显示半选状态。「编辑规则文件」查看原始文本，「更换文件夹」切换文件夹，「清空规则」清空当前文件夹的规则。

选择会保存到该文件夹里的 `.feishuignore`，也可以手写。语法和 `.gitignore` 相同：每行一条规则，支持 `*` 和 `**`，末尾加 `/` 只匹配文件夹，`!` 开头表示恢复同步，`#` 开头是注释。规则相对于文件所在的文件夹，越深层的文件优先级越高，库根目录的 `.feishuignore` 对整个库生效。它是普通文件，可以提交到 Git，也可以复制到别的库复用。

```gitignore
# Projects/Alpha/.feishuignore
/Drafts/
*.draft.md
!/Drafts/keep.md
```

被忽略的内容会被目录同步、保存后同步和 `pre-push` 跳过。已经在飞书里的内容不会被删，只被已忽略笔记嵌入的图片也不会上传。手动同步单篇笔记不受影响。`.feishuignore` 读取失败时，同步会中止，不会在没有规则的情况下继续发布。Obsidian 的文件列表看不到以点开头的文件，请在这个页面或外部编辑器里修改。

### 自动同步

自动同步只更新已经绑定的笔记，不会发布新文件。先手动发布一次，再到 **设置 → 同步 → 自动同步方式** 里选择：

| 方式 | 何时同步 | 说明 |
| --- | --- | --- |
| `关闭` | 只在手动同步时 | |
| `保存后同步`（默认） | 已绑定笔记保存后约 15 秒（「保存后同步延迟」） | Obsidian 需要在运行。Obsidian 打开该库时，用其他编辑器修改也会触发。 |
| `Git pre-push hook` | 每次 `git push` 之前 | 库必须是 Git 仓库，并在 **设置 → Git Hook** 里安装。不需要 Obsidian 在运行。同步失败时，这次 push 会被阻断。 |

自动同步覆盖 Markdown 笔记和它们引用的图片、视频。PDF 需要手动同步或目录同步。被忽略的内容会跳过。

### 已发布文件

点左侧栏的纸飞机图标，或在命令面板运行「已发布文件」。每一行显示文件名和本地路径，「在飞书打开」打开远端文件。「更多」菜单有复制链接、打开本地文件、同步、设置链接和移除已保存链接（本地和飞书的文件都会保留）。

移除目录链接时，也会移除该目录下全部子目录、笔记和 PDF 的链接记录，并清理笔记的增量同步缓存。旧版本移除目录后残留的子记录会在插件加载时清理。源笔记中的 frontmatter 保留，旧链接不会自动恢复绑定。

旧版本在关闭 frontmatter 时没有记下链接。「查找已有链接」会按文件名在已关联的飞书目录里匹配，不会创建文件。匹配到多个时，请手动设置链接。

---

## 设置一览

| 设置项 | 作用 | 默认值 |
| --- | --- | --- |
| `语言` | 设置、菜单和通知的显示语言（中文或 English） | 中文 |
| `默认上传位置` | 新文档存放位置：Wiki URL、Wiki 节点 token 或文件夹 token。留空为个人文档库 | 留空 |
| CLI 与授权 | 安装或升级 `lark-cli`、创建 CLI 应用、登录或退出、设置路径。见[第 2 步](#2-连接账号) | |
| `网络代理` | 继承系统环境变量、自定义 HTTP 代理或不使用代理 | 继承系统环境变量 |
| `标题来源` | 第一个 Markdown 标题，或文件名 | 文件名 |
| `原生 Callout 折叠` | 导出真实折叠父子块；已有文档首次转换会重建正文，已转换文档在关闭后仍使用原生同步 | 关闭 |
| `科研标签配色` | 在原生导出中将冒号前的加粗标签设为红字、黄色背景 | 关闭 |
| `写入 frontmatter 绑定信息` | 额外把链接写成 `lark_doc_url`。插件数据中的绑定始终保留 | 关闭 |
| `同步后打开文档` | 发布或同步成功后在浏览器中打开文档 | 开启 |
| `同步策略` | `自动（推荐）`：小改动只更新变动的块，较大或较复杂的改动改为全量覆盖。`安全增量同步`：从不覆盖，不适合增量时报错。`全量覆盖同步`：每次都重写远端文档 | 自动 |
| `自动同步方式` | `关闭`、`保存后同步` 或 `Git pre-push hook`。见[自动同步](#自动同步) | 保存后同步 |
| `保存后同步延迟` | 保存后等待的秒数，把连续编辑合并成一次同步 | 15 |
| `同步忽略` | 打开[「同步忽略」页面](#忽略文件和文件夹) | |
| `删除本地已不存在的飞书文件` | 目录同步后，提示删除本地文件已不存在的远端文件 | 关闭 |
| `同步状态缓存` | 为增量同步保留多少篇文档的状态 | 100 |
| `安装 hook` | 把 `pre-push` hook 安装到库的 `.git/hooks` | |

---

## 同步原理

插件把 Markdown 拆成顶层块，并记录它们在飞书 / Lark 里的 block id。之后的同步只更新变化的块，比如替换、插入或删除一个段落，飞书 / Lark 因此能保留对应的历史。只有选择覆盖，或自动策略判断改动太大、太复杂时，才会重写整篇远端文档。

![远端历史](./docs/images/lark-history.png)

本地 Markdown 是内容来源。远端文档被人手动改过的话，请先把改动合并回本地 Markdown，否则之后的同步可能会把它们替换掉。

插件数据放在 `.obsidian/plugins/feishu-docs-publisher/`。`data.json` 保存设置、绑定、原生导出状态和待确认记录，不受缓存裁剪影响。`lark-sync-state.json` 保存增量同步状态。

---

## 常见问题

| 现象 | 检查什么 |
| --- | --- |
| 新文档标题是 `Untitled`，或同步立刻报错 | `lark-cli` 版本过低，到 **设置 → CLI 与授权** 升级。 |
| 找不到 `lark-cli` | 点「重新检测」，或在「lark-cli 路径」里填绝对路径。没有 npm 的话先装 Node.js。 |
| 安装或同步时连不上网络 | 检查「网络代理」。 |
| 提示「默认上传位置无效或无法访问」 | 「默认上传位置」必须是你的账号能打开的 Wiki URL、Wiki 节点 token 或文件夹 token。 |
| 自动同步没反应 | 笔记必须先发布过。另外确认「自动同步方式」不是 `关闭`，选「保存后同步」时 Obsidian 在运行，且笔记没有被 `.feishuignore` 跳过。 |
| `git push` 被阻断 | `pre-push` 里的同步失败了。处理它报的错误，或把「自动同步方式」改成别的选项。 |

---

## 从 Feishu Lark CLI Sync 迁移

插件 ID 从 `feishu-lark-cli-sync` 改成了 `feishu-docs-publisher`，所以 Obsidian 会用新的数据目录。桌面端启动时，如果 `.obsidian/plugins/feishu-docs-publisher/data.json` 还不存在，插件会把旧目录 `.obsidian/plugins/feishu-lark-cli-sync/` 里的 `data.json` 和 `lark-sync-state.json` 复制过来（有才复制）。旧目录保持原样。

1. 启用本插件，并禁用已归档的旧插件，避免两个插件同步同一批笔记。
2. 用 `pre-push` hook 的话，请打开一次 Obsidian。hook 由本插件或旧插件安装过时，这会刷新 hook 脚本。设置页里 Git Hook 状态不是已安装的话，请重新安装。hook 在新目录有 `data.json` 时读新目录，否则读旧目录。

想在打开 Obsidian 之前就把文件放好：

```bash
mkdir -p "/path/to/your/vault/.obsidian/plugins/feishu-docs-publisher"
cp "/path/to/your/vault/.obsidian/plugins/feishu-lark-cli-sync/data.json" \
  "/path/to/your/vault/.obsidian/plugins/feishu-docs-publisher/data.json"
cp "/path/to/your/vault/.obsidian/plugins/feishu-lark-cli-sync/lark-sync-state.json" \
  "/path/to/your/vault/.obsidian/plugins/feishu-docs-publisher/lark-sync-state.json"
```

不存在的文件可以跳过，新目录里已有的文件不会被覆盖。

---

## 网络与第三方账号披露

- **第三方账号**：同步需要飞书或 Lark 账号。登录、退出和重新授权都可以在插件设置的「CLI 与授权」中完成；插件只调用本机 [`lark-cli`](https://github.com/larksuite/cli)，不收集应用密钥。
- **网络访问**：安装或升级 `lark-cli` 时，插件会调用本机 npm 访问 npm Registry，并由 `@larksuite/cli` 的安装脚本下载对应平台的官方程序。发布、同步、覆盖、查找链接和版本检查会调用 `lark-cli`，向飞书 / Lark 官方 Open API 发送 HTTPS 请求（飞书账号使用 `open.feishu.cn`，Lark 账号使用 `open.larksuite.com`）。手动同步或发布时会发起请求；开启「保存后同步」或 Git `pre-push` hook 后，这些操作也会发起请求。插件没有单独的统计上报通道。
- **凭据存储**：登录凭据保存在本机 `lark-cli` 的认证存储中。本插件不会把应用密钥或 access token 写入笔记、`data.json` 或日志。文档 URL 和绑定保存在插件数据中；开启对应设置时，也会写入笔记 frontmatter。

---

## 来源与致谢

本项目基于 [wanghuan9/obsidian-feishu-lark-cli-sync](https://github.com/wanghuan9/obsidian-feishu-lark-cli-sync)（作者 huan.wang，GitHub 用户 wanghuan）按 MIT 许可证派生。原仓库和原作者的 GitHub 账号已不可用，原插件「Feishu Lark CLI Sync」也已在 Obsidian 社区插件目录中归档。本项目从 0.1.26 继续开发，插件 ID 改为 `feishu-docs-publisher`，由 [totok22](https://github.com/totok22) 维护，新增了已发布链接管理、PDF 同步与去重等能力和相关同步修复。本项目与原作者没有官方隶属关系，也与 [zktww/feishu-lark-sync](https://github.com/zktww/feishu-lark-sync)（「Feishu Lark Sync」）无关，后者是独立代码库。原作者版权保留在 `LICENSE` 中。

---

## 开发与发布

```bash
npm install
npm test
npm run build
```

`npm test` 做类型检查并运行测试。`npm run build` 生成 `main.js`，该文件已加入 `.gitignore`。`npm run check` 两者都跑。

版本历史见 [CHANGELOG.md](./CHANGELOG.md)，每个 GitHub Release 的正文来自 [`release-notes/`](./release-notes/) 里同版本的文件。发布新版本的步骤：

1. 在 `CHANGELOG.md` 里加上该版本，并创建 `release-notes/<版本>.md`，第一行必须是 `# <版本>`。
2. 运行 `npm version <版本> --no-git-tag-version`，它会更新 `package.json`、`package-lock.json`、`manifest.json` 和 `versions.json`。
3. 运行 `npm run check` 和 `npm run release:check`。
4. 提交并推送，然后推送与版本号完全一致、不带 `v` 前缀的标签，例如 `0.3.0`。
5. `.github/workflows/release.yml` 会核对标签和发布说明，运行测试与生产构建，为三个插件文件生成构建证明，并创建草稿 Release。审核后发布。

发布构建也支持在 GitHub Actions 中手动运行，指定一个已有 tag。流程仍会检查版本和发布说明，并创建草稿 Release。

原生 Callout、PDF 裁剪和科研配色源自 [HeShiLie 的 fork](https://github.com/HeShiLie/feishu-docs-publisher)，已整合到本项目并补充开关和视频兼容。

## 许可

MIT 许可证。Copyright (c) 2026 huan.wang、totok22 和 HeShiLie。详见 `LICENSE`。
