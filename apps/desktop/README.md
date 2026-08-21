# AI Reading Companion Desktop Alpha

独立桌面 App 的第一个可运行切片。它与 Obsidian 插件共处于同一仓库，但拥有独立依赖、构建产物和质量门禁。

## 当前能力

- 创建本地项目，并导入单个或目录内的 Markdown；
- 把标题、段落、列表、引用、代码、表格和图片引用解析为带行号的内容块；
- 在项目范围内做词法检索；
- 选中原文后建立问题，并把问题组织成父子树；
- 粘贴、编辑并保存外部模型回答；
- 保存仍可编辑的用户摘录和个人解释；
- 使用 SQLite 在本地持久化项目、文档、问题、答案和摘录。

原始 Markdown 保持只读。首版导入限制为最多 500 个文件、单文件 5 MiB、总计 50 MiB，并跳过符号链接。

## 本地运行

```powershell
npm install
npm run verify
npm run dev
```

也可以从仓库根目录运行：

```powershell
npm run desktop:verify
npm run desktop:dev
```

## 当前非目标

- 尚未接入共享 Agent Runtime；当前回答区用于人工录入或粘贴网页端回答；
- 尚未提供系统密钥存储和模型方案管理；
- 尚未提供 Markdown 导出、`.docx`、本地图片读取和文档重新锚定；
- 不包含云同步、移动端、向量库和自动生成的知识图谱。

这些能力会按仓库中的阶段计划继续开发。
