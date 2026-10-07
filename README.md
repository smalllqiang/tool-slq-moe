# tool-slq-moe

sq's tool website —— 一些自用的小工具集合。

## 工具列表

| 工具     | 入口                           | 说明                                               |
| -------- | ------------------------------ | -------------------------------------------------- |
| 文本对比 | [textdiff.html](textdiff.html) | 左右两栏对比文本差异，按行显示增删，行内高亮到词级 |

## 文本对比

- 基于 Myers diff 做行级对比，小文本下为最少编辑数。
- 大文本按内存预算自动降级：超过预算改用 anchor（patience 风格）切分区间后再精确对比，保证结果始终能还原两侧原文。
- 删除行与新增行会做相似度配对（token 多重集 Dice 系数），相近的行合并显示为「修改」并高亮词级差异。
- 未匹配的块内用 DP 做单调配对，规模过大时退化为按序号配对。
- 输入上限约 20000 行（两侧合计），超出会提示分批对比。
- 快捷键：`Ctrl/Cmd + Enter` 执行对比；另有「交换」「清空」按钮，右上角显示 `−删除 +新增` 行数。
- `textdiff.js` 同时导出 `myersDiff`、`diffLines`、`buildRows` 等函数供 Node 使用（`module.exports`），可单独做单元测试。

## 本地预览

直接双击 `index.html`，或起一个静态服务器：

```sh
python3 -m http.server 8000
# 然后访问 http://localhost:8000
```

## License

[MIT](LICENSE) © 2026 smalllqiang
