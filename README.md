# tool-slq-moe

sq's tool website —— 一些自用的小工具集合。

## 工具列表

| 工具     | 入口                           | 说明                                               |
| -------- | ------------------------------ | -------------------------------------------------- |
| 文本对比 | [public/textdiff.html](public/textdiff.html) | 左右两栏对比文本差异，按行显示增删，行内高亮到词级 |
| 乱码恢复 | [public/mojibake.html](public/mojibake.html) | 输入乱码，用一个编码矩阵试出原文                   |
| 正则可视化 | [public/regex.html](public/regex.html) | 输入正则，勾选标志，查看结构图并实时测试匹配       |

## 文本对比

- 基于 Myers diff 做行级对比，小文本下为最少编辑数。
- 大文本按内存预算自动降级：超过预算改用 anchor（patience 风格）切分区间后再精确对比，保证结果始终能还原两侧原文。
- 删除行与新增行会做相似度配对（token 多重集 Dice 系数），相近的行合并显示为「修改」并高亮词级差异。
- 未匹配的块内用 DP 做单调配对，规模过大时退化为按序号配对。
- 输入上限约 20000 行（两侧合计），超出会提示分批对比。
- 快捷键：`Ctrl/Cmd + Enter` 执行对比；另有「交换」「清空」按钮，右上角显示 `−删除 +新增` 行数。
- `textdiff.js` 同时导出 `myersDiff`、`diffLines`、`buildRows` 等函数供 Node 使用（`module.exports`），可单独做单元测试。

## 乱码恢复

同一个字节流按不同编码解读就会变成乱码，反过来试一遍通常就能还原。输入一段乱码，下面给出完整的编码矩阵：

- 表格的**列**是「现在编码」（当初被误用的那个），**行**是「原来编码」（想恢复成的那个）。
- 单元格 = 把输入按该列编码还原成字节，再用该行编码解码的结果；哪一格重新变得可读，原文就是它。由用户自己判断，工具不做打分。
- 支持的编码：UTF-8、ISO-8859-1、windows-1252、GBK、Big5、Shift_JIS、EUC-KR、Unicode（UTF-16LE）。
- 标「不可用」的格子表示前提不成立——输入里含有该编码根本表示不了的字符，点开可以看到具体是哪些字符。
- 点击格子可查看不截断的完整结果，并能「复制」或「作为输入」再试一轮（对付二次乱码）。
- 输入上限 20000 字符，超出只取前 20000 字符；表格单元格只预览前 600 字符。
- `mojibake.js` 同样可用于 Node（`module.exports` 导出 `encodeTo`、`decodeFrom`、`recoverCell`、`recoverTable` 等）。

实现上有两点值得记一笔：浏览器的 `TextEncoder` 只支持 UTF-8，所以 `encodeTo` 对 GBK/Big5/Shift_JIS/EUC-KR 是用 `TextDecoder` 遍历所有合法字节序列建反查表得到的（首次使用该编码时构建并缓存，约几毫秒）；另外按 WHATWG 规范 `TextDecoder('iso-8859-1')` 实际等价于 windows-1252，两者会给出完全相同的结果，因此 ISO-8859-1 是手工实现的，保证 0x00–0xFF 与 U+0000–U+00FF 一一对应。

## 正则可视化

把正则表达式拆成结构图：顺序、分支、分组、量词都用嵌套方框表示，特殊元素标注中文含义，结构图和原始表达式可以互相悬停高亮。

- 输入框旁可勾选 `i`（忽略大小写）、`g`（全局）、`m`（多行），另外提供 `s`（点号匹配换行）和 `u`（Unicode）。粘贴 `/pattern/gi` 形式的字面量会自动拆出表达式和标志。
- 支持捕获组、命名捕获组、非捕获组、先行/后行断言、字符组与范围、Unicode 属性、反向引用、贪婪/懒惰量词等常见写法；某个写法超出解析范围时退回按原文显示，不影响匹配测试。
- 下方的「匹配测试」实时高亮匹配，并列出每次匹配的位置、编号捕获组和命名捕获组。
- 匹配在 Web Worker 中执行，超过 1 秒会中止并提示，避免灾难性回溯卡死页面；Worker 不可用时退回主线程，并跳过含嵌套量词的表达式。
- 表达式上限 2000 字符；测试文本只取前 2000 字符，最多显示 500 个匹配（列表最多 200 条）。
- `regex.js` 导出 `parseRegex`、`matchText`、`riskyPattern`、`splitRegexLiteral` 等函数供 Node 使用（`module.exports`）。

## 目录结构

- `public/` —— 唯一会被发布到 Cloudflare 的目录，新增页面/资源都放这里。
- 仓库根目录（`README.md`、`LICENSE`、`wrangler.jsonc`、`.git/`）不会被上传。

## 本地预览

直接双击 `public/index.html`，或起一个静态服务器：

```sh
python3 -m http.server 8000 -d public
# 然后访问 http://localhost:8000
```

## 部署

Cloudflare Workers Builds 配置：

- 构建命令：`exit 0`（纯静态，无需构建）
- 部署命令：`npx wrangler deploy`

`wrangler.jsonc` 中 `assets.directory` 固定指向 `./public`。

## License

[MIT](LICENSE) © 2026 smalllqiang
