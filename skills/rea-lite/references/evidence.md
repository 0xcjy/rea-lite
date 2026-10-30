# 完整 Evidence 与小视图

用 `run -- <command> ... --format json` 显式请求 JSON。解析返回的 stdout_file，不解析 stdout_preview；后者可能截断。stdout 文件保存 CLI 实际给出的完整字节，但用户显式传入 token-limit/filter-output 等上游参数时，输出本身可能不完整，不能直接作 inline source。
保留 evidence_id、subject（含 digest）、normalized_result、limitations；引用真实 REA Evidence ID。run 目录只是本机文件位置，绝不是 Evidence ID。

区分 observed / inferred / unknown。静态分析不证明执行；部分覆盖、空 metadata、未观察到均不等于不存在。不要从摘要补造父记录。
CLI 不共享 MCP 进程的 retained-evidence ID，也不假定两个 CLI 进程共享 retained ID；跨进程携带完整 Evidence 文件，用 inline source。

## 可执行 Node 配方

先运行完整分析（替换实际绝对路径）：

```text
node <skill-dir>/scripts/rea-lite.mjs run -- analyze-javascript-application <app-dir> --format json
```

把以下脚本保存在调用者自选的文件，例如 `make-view.mjs`。只使用 Node 内置 fs，第二个参数是完整 stdout.txt，第三个是新的输入文件。`wx` 拒绝覆盖。读取巨大 JSON 仍受上游和 Node 内存限制；wrapper 的流式分页不代表可无限内存查询 JSON。

```js
import { readFile, writeFile } from 'node:fs/promises';
const [sourceFile, inputFile, kind = 'summary', nodeId] = process.argv.slice(2);
if (!sourceFile || !inputFile) throw new Error('sourceFile and new inputFile required');
const evidence = JSON.parse(await readFile(sourceFile, 'utf8'));
let view;
if (kind === 'summary') view = { kind: 'summary' };
else if (kind === 'page') view = { kind: 'page', collection: 'modules', offset: 0, limit: 16 };
else if (kind === 'item' && nodeId) view = { kind: 'item', collection: 'modules', selector: { node_id: nodeId } };
else throw new Error('Use summary, page, or item with an actual returned node_id');
await writeFile(inputFile, JSON.stringify({ source: { kind: 'inline', evidence }, view }), { flag: 'wx' });
```

```text
node make-view.mjs <full-stdout.txt> <new-summary.json> summary
node <skill-dir>/scripts/rea-lite.mjs run -- inspect-analysis-view <new-summary.json> --format json
node make-view.mjs <full-stdout.txt> <new-page.json> page
node <skill-dir>/scripts/rea-lite.mjs run -- inspect-analysis-view <new-page.json> --format json
node make-view.mjs <full-stdout.txt> <new-item.json> item <actual-node-id-from-page>
node <skill-dir>/scripts/rea-lite.mjs run -- inspect-analysis-view <new-item.json> --format json
```

选择 page 返回的真实 node_id 与角色，不杜撰 ID。相同路径可能有多个角色；下一页按真实 coverage.next_offset 调整 offset。item 返回记录的路径和观察，不保证包含所有子语法或源码全文。每个视图也有自己的 Evidence ID 和真实 parent_evidence_id。

上述 summary/page/item 契约来自原 REA JavaScript guide；当前 `inspect-analysis-view --schema` 仅有 inputJson 字符串，不暴露嵌套契约。未知复杂 workflow 必须查已安装 REA skill 的相关 guide 或针对性文档，不猜查询语言。不同版本若拒绝输入，应读原始错误与同主题 guide 修正，不改用假摘要或重复分析掩盖分页问题。
