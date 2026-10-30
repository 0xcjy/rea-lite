# 按需 CLI

所有示例中的 `<skill-dir>` 都应替换为此 skill 实际所在的绝对目录；不依赖 cwd。
需要已安装 REA 和 Node；无需注册 MCP、npm install 或后台服务。

```text
node <skill-dir>/scripts/rea-lite.mjs find <words...>
node <skill-dir>/scripts/rea-lite.mjs help <command>
node <skill-dir>/scripts/rea-lite.mjs schema <command>
node <skill-dir>/scripts/rea-lite.mjs run -- <command> [args...]
node <skill-dir>/scripts/rea-lite.mjs read <file> [--offset N] [--limit N]
```

- 无参数、`--help`、无词 find：只显示短帮助，不启动 REA。
- find 执行一次根帮助，所有空白分隔词均按大小写不敏感的字面量匹配命令/描述，最多 12 条；matched/returned 表示数量。零匹配返回空数组。帮助格式无法识别时报错并给出完整文件，不回退到静态目录。
- help/schema 要求一个形如 `inspect-go-binary` 的小写连字符命令；未知命令由 REA 报错。schema 调用 `--schema --format json`，不能保证暴露 inputJson 内部契约。
- run 分隔符后参数原样传递；只拒绝根 `--mcp` 和 `mcp` 命令。不自动附加格式、过滤或 token 参数，不执行 shell。空格/中文/引号是普通参数。
- read 不启动 REA；offset 从零开始，按 Unicode code point 计数（非字节、非 UTF-16 code unit）。默认 offset=0、limit=2048，limit=1..8192。返回 `{file,offset,text,next_offset,eof}`，超出末尾返回空文本且 eof=true。按 next_offset 继续；错误保留原因。读取使用有界流，跳过巨大 offset 仍需扫描前文。

## 后端定位

顺序：显式 `REA_LITE_REA`；从 skill 位置向上寻找 `node_modules/rea-agents/package.json`；PATH 中安装的 rea。
变量只能是现存的公共 JS 入口 `.mjs/.js/.cjs` 或原生可执行文件，不能是目录、`.cmd/.bat`；显式错误不回退。包入口从 package.json 的 bin.rea 读取，不引用私有 dist。
PATH 的 Windows rea.cmd 仅用于找到同目录 node_modules 的包，不执行或解析脚本；POSIX rea 经 realpath 后为 JS 则由当前 Node 启动。JS 始终通过 `process.execPath` 与参数数组启动；原生入口直接启动，shell:false，cwd/环境/stdin 继承。

PowerShell（按本机实际公共入口修改）：

```powershell
$env:REA_LITE_REA = 'C:\Program Files\REA\scripts\rea.mjs'
node 'D:\AI skills\rea-lite\scripts\rea-lite.mjs' help inspect-go-binary
```

找不到后端：将变量设为已安装 REA 的公共入口；不会自动 npx、doctor、setup、升级或下载。REA 自身声明的 Node 支持范围独立于 wrapper 的 >=22.19.0。原生、Android、固件等仍需原 REA 对应 provider；缺 provider 时保留错误，查该命令 help 和安装包相关 guide，不把注册 MCP 当成 CLI 前置条件。

## 输出和退出

每次启动后端先创建 cwd 下唯一 `.rea-lite/runs/run-*/`，保存完整 stdout.txt、独立 stderr.txt 和 meta.json，不覆盖、不自动清理。元数据记录原 argv、cwd、实际程序/入口、退出码、信号与 completed。普通非零退出仍可 completed=true；spawn/写流失败为 false。
run/help/schema 只输出 JSON 展示对象：路径、退出状态、stdout 前 4096 和 stderr 前 1024 个 code point、truncated 与 next_*_offset。截断时用 read，不能把 preview 当完整 Evidence。find 仅输出匹配和文件位置，不泄露整个目录。

wrapper 参数错误退出 2；定位/文件/捕获错误退出 1；普通 REA 退出码原样透传；信号退出为非零且保存 signal。后端错误应读取 stderr_file；未知命令先 find 再 help，无须反复拉根目录。捕获不设重试、自动超时、缓存或后台服务。文件输出失败可能只能在 wrapper stderr 报告，不能视为成功 Evidence。

## 机器级 provider 变量

skill 目录可整体复制，但 provider 路径属于机器。wrapper 在启动 REA 前读取可选文件 `~/.rea-lite/env.json`（JSON 对象，值必须是字符串），仅补充调用者未定义的变量；调用者环境优先。`REA_LITE_ENV_FILE` 可指定其他路径，此时文件缺失会报错而不是静默跳过；JSON 无效或含非字符串值同样非零退出且不启动后端。实际读取路径记录在 meta.json 的 `env_file`。

```json
{
  "GHIDRA_INSTALL_DIR": "D:\\env\\ghidra\\ghidra_12.1.4_PUBLIC",
  "JAVA_HOME": "D:\\env\\jdk21\\jdk-21.0.12.1+1",
  "REA_IDA_MCP_CONFIG": "C:\\Users\\<you>\\.rea\\ida-mcp.json"
}
```

## 原生 provider

Ghidra 由 REA 子进程继承的环境决定：`GHIDRA_INSTALL_DIR` 指向已解压版本（含 `support/analyzeHeadless`），并令 `JAVA_HOME` 指向兼容 JDK。示例（PowerShell）：

```powershell
$env:GHIDRA_INSTALL_DIR = 'D:\env\ghidra\ghidra_12.1.4_PUBLIC'
$env:JAVA_HOME = 'D:\env\jdk21\jdk-21.0.12.1+1'
node scripts/validate-capabilities.mjs native
```

IDA 不是直接驱动：REA 只连接上游 `ida-pro-mcp` 的 stdio 或本机 HTTP 注册（`REA_IDA_MCP_CONFIG`）。本机已验证路径：安装 `ida-pro-mcp` 后其插件落在 `%APPDATA%\Hex-Rays\IDA Pro\plugins\mcp-plugin.py`，把注册文件写成 `{"mode":"attached","command":"<python.exe>","args":["<site-packages>/ida_pro_mcp/server.py"],"timeoutMs":600000}`，用 `ida64.exe -A -S<自启脚本> <目标>` 打开目标并启动端口 13337 的服务，再以 `--provider ida` 反编译。attached 模式要求请求文件与 IDA 已打开输入 SHA-256 一致；`idalib-mcp` 需要 IDA 9。Frida 通过本机 Frida 运行时工作；`list-frida-devices` 与自有 fixture 的 spawn 已验证，未附加他人进程。
