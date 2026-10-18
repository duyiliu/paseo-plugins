Agent CLI Monitor 在 Paseo 侧边栏直接显示本机正在运行的 agent CLI 实例数量和内存占用(RSS),不限定某一种 CLI,不用点开页面。

daemon 端枚举系统进程。Paseo 拉起 agent 时会把 PASEO_AGENT_ID 注入进程环境,插件据此识别所有 provider 的实例(claude、codex、devin 等,包括自定义 provider),不受可执行文件名限制;以每个带标记的最外层进程为根,把它的整棵子进程树(比如拉起的 shell)算进该实例的内存。每个实例反查对应 agent 的标题、状态、工作目录和运行时长,一眼看出是哪个会话在吃内存。同时汇总 Paseo 里各状态的 agent 会话数量。没有环境标记的进程一律不列——手动启动的 CLI、桌面应用内嵌的同名二进制(如 Codex 桌面版的 codex.exe)都不会混入。

每行实例带"关闭"按钮(两次点击确认):通过 daemon 的 agent 控制面关闭该 agent 的运行时——杀掉 CLI 进程、持久化会话快照,但**保留 agent 记录和历史、不归档**,下次点开自动恢复。适合回收闲置会话占用的内存。该功能依赖 daemon 配置 `daemon.mcp.injectIntoAgents: true`(向 agent 注入调用凭证);daemon 重启后存量凭证失效,对应 agent 需重新加载后按钮才恢复可用。

界面为纯手动刷新:侧边栏在应用启动时采集一次,明细屏用"刷新"按钮更新,不为监控本身周期性消耗资源。明细屏入口是点侧边栏那行,或 Command Center(Ctrl+K)搜索"Agent 进程监控"。内存数值为工作集(Windows)或 RSS(POSIX),仅供参考量级。
