---
knowledge_identity: user_curated
tags: [编程, shell]
---

# Shell 技巧

## 批量重命名

批量重命名最稳的方式是用循环加变量替换：`for f in *.txt; do mv "$f" "prefix_${f}"; done`。需要复杂规则时用 rename 命令或写一个 Python 脚本先 dry-run 打印新名字，确认无误后再执行。

## 常用快捷键

Ctrl+R 反向搜索历史命令，Ctrl+A 和 Ctrl+E 跳到行首行尾，Ctrl+U 删除整行。学会这三个快捷键比背很多命令更省时间。
