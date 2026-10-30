# rea-lite

已安装 REA 的零依赖轻量调用层，不是独立逆向引擎。短 skill 入口按需发现 CLI 能力；完整输出落盘，仅有界预览进入 AI 上下文。不创建 MCP 服务，不注册工具，不安装 REA 副本，不自动更改客户端配置。

## 最短上手

需要可运行 Node（wrapper >=22.19.0）与已安装 REA；无需 npm install，无 lockfile。REA 自身 Node 支持范围仍以其 package.json 为准：本机 6.5.0 声明 ^22.19.0 || ^24.11.0 || >=26.0.0，当前 Node 25 不在声明范围，本项目不自动升级。

```text
node skills/rea-lite/scripts/rea-lite.mjs find go
node skills/rea-lite/scripts/rea-lite.mjs help inspect-go-binary
node skills/rea-lite/scripts/rea-lite.mjs schema inspect-go-binary
node skills/rea-lite/scripts/rea-lite.mjs run -- inspect-go-binary <absolute-binary-path> --format json
node skills/rea-lite/scripts/rea-lite.mjs read <returned-stdout_file> --offset 0 --limit 2048
node --test
```

定位依次为 REA_LITE_REA、从 skill 位置向上的 node_modules/rea-agents、PATH。显式变量设为公共 JS 入口或原生程序，不设为 rea.cmd；错误不会触发下载、setup 或回退。JS 以当前 Node 参数数组启动，shell:false。原生/Android/固件等仍需原 REA 对应 provider。

## 给 AI 使用

复制整个 `skills/rea-lite` 目录到支持 skill 的客户端可读位置即可；也可直接把 SKILL.md 和该目录实际绝对路径交给 AI。运行时代码全部在该目录内；模型应使用绝对脚本路径，不依赖 cwd。纯文本入口仍需要文件读取与 shell 执行能力，不能凭文本提供执行工具。不全局安装 skill。

若客户端仍启用了旧 REA MCP，其完整工具清单仍占上下文。需要用户自行禁用该注册并重连；本项目不自动修改现有注册，也不声称当前会话立即变短。原 skill 和客户端配置保持不变。

## 有界展示与证据

每次后端调用在调用者 cwd 的 `.rea-lite/runs/run-*/` 留下 stdout.txt、stderr.txt、meta.json；不覆盖历史、不自动删除。stdout/stderr 原字节分开存储，使用背压，不以 maxBuffer 截断。预览分别最多 4096/1024 个 Unicode code point；read 默认 2048、最大 8192，按 next_offset 继续，不重跑分析。

find 只展示最多 12 个匹配项。预览截断不等于完整 Evidence；路径不是 Evidence ID。引用真实 REA evidence_id，保留 subject/digest/limitations，区分观察、推断、未知。上游过滤/token 参数原样透传，但可能使结果不再适合作 inline Evidence。
上下文以入口字节/行数和输出字符预算控制，不承诺特定 tokenizer 的精确 token 数或未测量的节省比例。

按需阅读：
- [使用、后端定位、错误和退出码](skills/rea-lite/references/usage.md)
- [目标路线](skills/rea-lite/references/targets.md)
- [完整 Evidence 和跨进程视图配方](skills/rea-lite/references/evidence.md)

测试使用临时模拟后端验证 wrapper 行为，不证明逆向能力；实际 REA 静态冒烟与 provider 相关能力应分别说明。不会自动执行分析目标、自动重试、添加超时、升级或启动后台服务。

## 初始冒烟

- `node --test`：7 项通过；覆盖完整字节保存、预览边界、退出码 7、后端/输出路径失败时不执行、参数无 shell 副作用、Unicode 分页、find 限额及目录迁移。
- 本机 REA 6.5.0 / Node v25.9.0：实际 find、help、schema、node.exe 静态 Go metadata inspection 成功；不改变 Node 支持范围声明。
- 实际分析临时 JS 应用，随后用完整 inline Evidence 分别生成 summary、modules page、真实 node_id item；父引用一致，item 保留 main.cjs 路径及 AST 静态观察。未执行该应用。
- 复制 skill 到含空格/中文的临时目录，从另一 cwd 调用真实 help，实际输出和元数据可读。
- SKILL.md 为 1128 UTF-8 字节、总 18 行、正文 14 行。实际 find go 返回 2 条；help 预览 820、Go run 预览 2308、JS run 预览 4096 个 code point（JS 完整输出 31580 字节，标记截断）。不把原生反编译或运行时观察列为已验证能力。

## 各类能力验证

```text
node scripts/validate-capabilities.mjs
```

也可运行 `npm run validate:capabilities`；无需 npm install。此命令独立于 `node --test`，调用真实已安装 REA，不使用模拟后端证明分析能力。使用当前 Node 启动公共 CLI；不同运行时/provider/版本可能改变结果。

验证器在 `.rea-lite/validation/run-*/` 生成受控样本和 report.json，每条检查指向 `.rea-lite/runs/` 中完整输出，并保留真实 Evidence ID、断言事实和失败原因。逐命令 command_coverage 明确记录没有实际检查的命令；读取帮助、provider 声称可用或命令退出 0 都不单独算功能通过。

状态区分 `passed`（已验证样本事实）、`blocked`（实际前置条件/平台阻断）、`failed`（断言或执行失败）、`not_tested`（未测）；`inventory` 仅表示发现信息。失败检查令验证器非零退出，阻断项不会冒充成功。

该显式集成命令会创建并运行自己生成的 Node Inspector 常驻样本，以及使用独立临时 profile 启动已安装 Chrome/Edge，服务 loopback 页面并操作已声明的测试按钮，结束后关闭自有进程。不会附加现有用户浏览器、操作真实 Android 设备、执行分析得到的代码、安装 provider 或修改客户端配置。可用 `REA_LITE_CHROME` 指定已有浏览器；缺失时记录 blocker，不下载。

验证使用完整 Evidence JSON 文件跨 CLI 进程传递；避免 Windows 长命令行限制。不将静态追踪当成运行时执行，不将未发现 Go/Rust metadata 当作正向语言样本成功，更不据少量样本声称全部 REA 命令等价覆盖。

实测矩阵、逐项边界和缺失前置条件见 [CAPABILITIES.md](CAPABILITIES.md)。配置 Ghidra/IDA/Frida 后全量集成已完成 48 项通过、14 项阻断、2 项未测、0 项失败（另有 1 项发现信息）；不是全部 REA 命令均已验证。wrapper 的 7 项行为回归也全部通过。

Ghidra 需 `GHIDRA_INSTALL_DIR` 与 `JAVA_HOME`；IDA 需 `ida-pro-mcp` 插件与 `REA_IDA_MCP_CONFIG`（attached 模式要求文件摘要与已打开输入一致）。这些变量可写在 `~/.rea-lite/env.json`，wrapper 会自动读取且调用者环境优先；详见 usage.md。

可以按族复跑，例如 `node scripts/validate-capabilities.mjs javascript browser`；支持 javascript、native、artifacts、browser、environment。Node Inspector 与浏览器动作使用自己的受控运行时样本；Rust/.NET 编译样本只做静态检查，不执行。
