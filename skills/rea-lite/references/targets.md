# 先确定目标，再发现命令

完整源码仓库用普通代码工具，不调用逆向引擎。只有用户目标不明确时才追问；不要把附近文件当成用户选定目标。
下表是发现路线，不是完整目录。`find` 以当前安装 CLI 帮助为准，再查具体 `help` / `schema`。

| 目标 | 首个路线 |
| --- | --- |
| JS/ASAR 或提取的应用目录 | `help analyze-javascript-application`，完整分析保存后按 Evidence 配方生成视图 |
| 原生程序/库 | `find inspect`、`find search`、`find function`、`find decompile`；按当前 help 的 CLI 路线打开目标和分析函数，需对应 provider |
| APK | `find android` |
| .NET/CLI 程序集 | `find managed` |
| 包/归档清单 | `find artifact` |
| 浏览器/Electron | `find browser` 或 `find electron`；区分只读观察和会执行的动作 |
| 离线流量 | `find capture`、`find network` 或 `find pcap` |
| WASM / Go / Rust | `find wasm` / `find go` / `find rust` |
| SQLite / 固件 / core | `find sqlite` / `find firmware` / `find crash` |

MCP 下划线名称不能直接作为 CLI 命令，也不假定每个 MCP 工具均有同名 CLI。发现结果中的连字符命令和实际 help 为准。
不要给 analyze-javascript-application 添加未展示的 `--detail summary`；当前路线是完整分析落盘，然后 inspect-analysis-view。

CLI 是原 REA 的调用途径，不增加 provider 或权限。缺失 Java/JADX、Ghidra、固件工具等只影响相应能力；不安装或启动无关依赖。静态读取目标不等于执行目标；浏览器动作、附加调试器、动态运行需在用户授权目标/动作范围内。
