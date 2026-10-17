Agent CLI Monitor 在 Paseo 侧边栏直接显示本机 devin CLI 实例的数量和内存占用(RSS),不用点开页面。

daemon 端枚举系统进程,以每个 devin 可执行文件为根,把它的整棵子进程树(比如拉起的 shell)算进该实例的内存。每个实例还会从进程环境里读 PASEO_AGENT_ID,反查出对应的 agent 标题、状态、工作目录和运行时长,一眼看出是哪个会话在吃内存。同时汇总 Paseo 里各状态的 agent 会话数量。

每行实例带"关闭"按钮(两次点击确认):通过 daemon 的 agent 控制面关闭该 agent 的运行时——杀掉 devin 进程、持久化会话快照,但**保留 agent 记录和历史、不归档**,下次点开自动恢复。适合回收闲置会话占用的内存。

界面为纯手动刷新:侧边栏在应用启动时采集一次,明细屏用"刷新"按钮更新,不为监控本身周期性消耗资源。明细屏入口是点侧边栏那行,或 Command Center(Ctrl+K)搜索"Devin 进程监控"。内存数值为工作集(Windows)或 RSS(POSIX),仅供参考量级。未关联到 Paseo agent 的 devin 进程(比如手动启动的)没有关闭按钮。
