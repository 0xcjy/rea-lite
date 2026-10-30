# REA Lite 能力验证矩阵

本矩阵验证 **rea-lite → 已安装 REA 公共 CLI → 真实结果** 的链路，不使用模拟后端证明逆向能力，也不是全部 MCP 工具的等价性认证。

## 已执行结果

完整集成运行（Ghidra + IDA + Frida 已配置）：**48 项 passed，14 项 blocked，2 项 not_tested，1 项 inventory，0 项 failed**。这些是检查项数量，不是 48 种独立能力；同一 CLI 命令可有正向、负向、分页等多个检查。另有 `node --test` 的 7 项 wrapper 行为回归全部通过。

已核对的完整记录：`.rea-lite/validation/run-snSAeg/report.json`。每个检查保留 command、完整 stdout_file/stderr_file、退出元数据、实际 Evidence ID（有返回时）及断言事实。REA 原始输出在 `.rea-lite/runs/`，不改写、不把预览当 Evidence。逐命令 `command_coverage` 覆盖本机 CLI 目录的 153 个入口：34 个通过所列功能样本、13 个受阻、1 个仅发现信息、105 个未测。48 个检查通过不代表全部命令或全部 MCP 能力通过。

环境：REA 6.5.0，wrapper 由 Node v25.9.0 启动；这不改变 REA 对 Node 支持范围的声明。验证本身不安装依赖、不改客户端注册；本次为验证 IDA 额外安装了 `ida-pro-mcp 1.4.0`（其插件写入 `%APPDATA%\Hex-Rays\IDA Pro\plugins`，需 `mcp<2`），并把该工具自行写入 Cursor/Claude 的 `ida-pro-mcp` 条目还原（备份为 `*.bak-rea-lite`）。

## 实测通过

| 能力族 | 已证明的具体行为 | 不能推出的结论 |
| --- | --- | --- |
| JS 静态应用分析 | 两个受控 CJS 应用均解析 1 个 JS 文件；识别导出、参数和应用图 | 不证明目标代码运行、动态分支可达或任意混淆均可恢复 |
| Evidence 视图 | 完整 inline Evidence 跨 CLI 进程生成 summary、modules page 和真实 node_id item；父 ID 一致 | 不证明 CLI 与 MCP 共享 retained ID |
| JS 版本/导出比较 | 区分两个版本；精确识别 `/enabled` 字段新增 | 不证明任意返回值、模糊实体匹配或运行时等价 |
| JS 特征/语义追踪 | main.cjs 模块种子命中；input 参数有 forward-influence 关系 | 保留 partial/unknown；静态关系不是执行轨迹 |
| Go 正向元数据 | 静态检查已有 gh.exe，恢复 Go 版本、主模块及 166 个依赖，源文件摘要相符 | 不证明编译器真实性、依赖安全或 Go 反编译能力 |
| Go/Rust 负向元数据 | node.exe 无对应 build-info / cargo-auditable metadata 时返回 null | 不证明程序不是 Go/Rust 或没有依赖 |
| Rust 元数据 | 使用已安装 rustc 编译但不执行样本；恢复 `/rustc/` 路径中的提交 hash | 该提交是推断；没有 `.dep-v0`，未证明可恢复 cargo-auditable 依赖列表 |
| PE 资源 | gh.exe 的 RT_VERSION 资源类型、范围及摘要正确 | 不证明原生伪代码、资源运行时使用方式 |
| GNU objdump | 已安装 objdump 对 Rust PE 生成真实 x86-64 反汇编；完整输出且目标摘要未变 | 不等于高层反编译或控制流/类型恢复 |
| .NET 静态元数据 | 编译但不执行 DLL；恢复程序集身份/MVID、类型、字段、方法签名、IL 中常量 42 | 不等于 C# 反编译、CLR 依赖解析或执行 |
| .NET 原生边界 | 恢复 kernel32.dll / GetCurrentProcessId 的 P/Invoke 声明 | 仅 managed-declaration-only；未验证真实 native export 或调用 |
| ZIP 清单与视图 | 五个含空格/中文路径的条目，字节数/摘要与本地已知内容一致；清单分页父引用正确 | 不是所有归档格式的完整兼容性证明 |
| 安全提取 | 已知 ZIP 文件逐字节一致；拒绝 `../` 路径穿越，canary 未写出 | 不是所有恶意归档/链接攻击的安全审计 |
| HAR 离线流量 | 两条 HAR 记录的 URL、201/418 状态、base64/plain body 保真；API surface 分组和父引用正确 | 不证明实时抓包、线上服务状态或抓包完整性 |
| Foundation Keyed Archive | XML/binary plist 的对象表、UID 引用、根对象和 marker 正确 | 不等于 macOS 原生工具或所有 archive 布局均已验证 |
| Apple/Android/Harmony 应用图 | 合成 IPA/APK/HAP 的清单路径、摘要、bundle/component 分类和桥接候选符合样本 | 合成包不可安装；魔数/路径不证明有效 Mach-O/DEX/ABC、清单语义或程序行为 |
| Node Inspector | 仅启动自己的 Node 样本；发现精确 target_id，观察加载脚本/上下文；结束后进程清理 | Windows URL 可能 unresolved，不能冒充已认证文件路径；不证明 Electron IPC |
| 浏览器被动观察 | 隔离 Chrome profile 和 loopback 页面；发现目标、观察按钮/文本、定位 click 监听器及源摘要 | 监听器存在本身不证明曾执行 |
| 浏览器截图 | PNG 签名、字节数、SHA-256 均匹配，保存 browser.png 并实际查看 | 不是视觉回归或所有窗口/DPI 的兼容性验证 |
| 浏览器动作 | REA 执行声明的 click，后续被动观察确证 `ready → clicked` | 只覆盖受控按钮，不操作用户已有浏览器或第三方网站 |
| SQLite | 已知表名、列顺序、integer/text 类型与值 `7` / `REA_LITE_SQLITE` 正确 | 不证明任意损坏/加密库、恢复已删除记录或活动 WAL 的原子快照 |
| Ghidra 原生分析 | 本机 Ghidra 12.1.4 + JDK21：受控 C 样本的段表/过程数正确；反编译 `compute_score` 得到 `param_1 * 3 + 7`、`100` 上限与 `return`；过程搜索命中真实地址；xrefs 非空 | 仍依赖调用者提供 `GHIDRA_INSTALL_DIR`/`JAVA_HOME`；不证明大型/加固目标或全部架构可分析 |
| Frida 附加 | 本机 Frida 17.24.3：发现 local device；spawn 自有 1 行 C 程序，脚本回传 `REA_LITE_FRIDA` 与模块大小，`state=detached`、`cleanup_error=null`、PID 有效 | 未附加用户进程、未覆盖 Android/iOS 设备、未验证复杂 hook 或反调试绕过 |
| IDA 附加反编译 | 本机 IDA Pro 8.3 + ida-pro-mcp 1.4.0 插件：`REA_IDA_MCP_CONFIG` 注册 stdio 桥接后 provider 变为 available；对已在 IDA 打开的受控样本反编译 `compute_score`，得到 `3 * a1 + 7`、`> 100`、`return 100i64` | 仅 attached 模式且必须 SHA-256 匹配已打开输入；idalib headless 需 IDA 9，未验证；16 位/批处理与反编译器插件差异未覆盖 |

## 实际阻断与未测

- **IDA 已接通但有边界**：REA 不直接驱动 IDA，只连上游 ida-pro-mcp。本机已安装插件与 `REA_IDA_MCP_CONFIG`，验证走 attached 模式（IDA 打开的目标必须与请求文件摘要一致）；`idalib-mcp` 需要 IDA 9 的 `idapro` 模块，8.3 不可用。
- Hopper 不支持 win32（provider 明确报 `unsupported_host`）。
- pwntools binary-layout、EVM profile、Binwalk 固件和 sigrok 信号路线有 Linux/工具前置条件；Windows PTY 捕获因 descendant cleanup 未验证而被上游拒绝。
- WABT 缺少 `REA_WABT_BIN_DIRECTORY`；未找到现有 wasm-objdump/wasm2wat，不下载补齐。
- Android JADX MCP JAR、apktool 和 adb 未配置/不可用；Wireshark tshark/capinfos 不可用；Wakaru 恢复入口要求对应工具。清单投影通过不代表这些解析/反编译/解码也通过。
- Electron 专有运行时（IPC、preload、fuses）、真实 Android 设备、Frida 注入和 Linux core 工作流未测；未擅自选择用户进程/设备。
- provider inventory 曾把 SQLite 标成 unsupported_version，但实际 SQLite 操作成功。**最终能力结论以实际调用和语义断言为准，inventory 只作诊断。**

## 复跑

```text
node --test
node scripts/validate-capabilities.mjs
node scripts/validate-capabilities.mjs javascript browser
node scripts/validate-capabilities.mjs native artifacts environment
```

完整运行也可用 `npm run validate:capabilities`，不需要 npm install。每次使用新的 validation/run-* 和 runs/run-* 目录，不覆盖历史证据。可通过 `REA_LITE_CHROME` 指定已有 Chrome/Edge。验证会编译受控 Rust/.NET 样本但不执行它们；只运行自己生成的 Node 常驻样本与隔离浏览器/loopback 服务，并核对关闭。检查失败返回非零；blocked/not_tested 不算功能通过。

本项目没有禁用旧 MCP、没有注册新 MCP，也没有把完整能力矩阵塞入短 SKILL.md；复制 skill 的使用入口大小不受这些验证脚本影响。
