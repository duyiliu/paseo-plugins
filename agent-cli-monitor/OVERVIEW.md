Agent CLI Monitor 在 Paseo 侧边栏直接显示本机 devin CLI 实例的数量和内存占用(RSS),不用点开页面。

daemon 端枚举系统进程,以每个 devin 可执行文件为根,把它的整棵子进程树(比如拉起的 shell)算进该实例的内存。同时汇总 Paseo 里各状态的 agent 会话数量。界面每 5 分钟自动刷新,明细屏里可手动刷新。

明细屏入口是点侧边栏那行,或 Command Center(Ctrl+K)搜索"Devin 进程监控"。内存数值为工作集(Windows)或 RSS(POSIX),仅供参考量级。
