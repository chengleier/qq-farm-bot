# 微信连接适配与掉线诊断

Windows 微信真实样本（2026-09-25）确认：客户端为 `1.14.2.13_20260922`，TSDK 为 `v3.9.0.1790237209`，登录渠道为 `other`。约 12 分钟内有 28 组心跳与 43 组 AntiData 往返，没有 Kickout；这不是超过三小时的稳定性结论。

## 平台适配

- 账号为 wx/wechat 且使用内置 QQ 默认版本时，握手、Login 和 Heartbeat 统一选择微信版本；自定义版本继续生效。QQ 保持原有版本与完整初始化凭据向量。
- 微信 Login 使用渠道 `other`，从设备配置读取 network、memory 和 device_id。没有小游戏启动上下文时省略 scene_id，不套用本次样本的入口值。
- 微信独立加载 `core/src/utils/tsdk-wx.wasm`，QQ 继续加载 `tsdk.wasm`。两者分别校验 SHA-256，容器与 pkg 资源清单均包含微信 WASM。
- 微信 WASM SHA-256：`4bf6aa0ede9677fe82186c1a76f8df8a14ccd6d14b6ff1280230923189f4e972`；QQ 仍为 `2c9e377ecc9a4fd9019f12191b589d543a60d6654580eb3e237b35f1fa5b1cb7`。
- ACE 请求按运行实例隔离：停止后到达的旧响应不再进入新实例，也不重置新实例的请求状态。5 秒处理周期、25 秒心跳及各分支调度策略保持原有设计。

## 已知能力边界

真实服务端非空 AntiData 在旧、新 WASM 离线回放时，均触发 `imports.a.e`（ACEVM）。当前 Node 宿主仍缺少这项小游戏运行环境能力。此次改动保留空结果并明确记录触发次数与时间，不伪造通过结果。升级 WASM 不等于补齐 ACEVM，也不能据此宣称微信掉线已修复。

官方版本中的 UserCryptoManager 尚未启用；debug 值 2 对应 enableDebug=false。没有证据支持随意修改它们。微信实际设备宿主信息尚未完整验证，不能套用 QQ 的固定宿主参数。

## 定位实际退出

断开与 Kickout 日志在清空队列、销毁 WASM 前保存 diagnostics：

- platform、clientVersion、connectionAgeMs；
- lastInboundAgeMs、lastHeartbeatAgeMs、heartbeatMissCount；
- pendingRequests、queuedRequests 与请求积压；
- ace 的请求/回复/非空回复/失败次数及最近收发、处理时间；
- tsdk 的版本、就绪状态、unsupportedAceVmCalls 与 lastUnsupportedAceVmAt。

踢出数字使用 reasonCode，连接关闭码使用 disconnectCode；仅明确列出的整数诊断码通过日志脱敏，登录 Code、Token 和字符串形式的敏感字段仍会隐藏。普通空 AntiData 回复也计入成功往返，不能当作未收到响应。

复现时关闭同账号官方农场与其他机器人实例，用新 Code 登录。先关闭业务自动操作、保留正常心跳和 TSDK，至少测试 4 小时，再逐项恢复业务。保留退出前 10–15 分钟到之后 1 分钟的 combined.log、构建版本、登录方式、设备配置及容器/进程重启情况。不要同时登录官方端干扰踢出原因。

官方微信在本机绕过系统代理。采样需确认真正记录了 platform=wx 的握手与双向消息，不能只看 Helper 处于监听状态。结束采样应恢复临时代理并记录人为停止时间。原始抓包、日志和分析数据库留在本地 output/，不提交公开仓库。

## 仓库中的验证材料

保留可重复执行的协议、会话隔离、诊断脱敏与打包清单回归测试。微信测试使用合成输入，不包含登录 Code、OpenID 或原始 AntiData 样本；真实回包验证仅在本地执行。

历史寻宝测试中的好友 GID 与包含账号前缀的记录 ID 已替换为合成标识，重新编码 Protobuf 后继续验证完整结构。生成的运行日志/性能分析产物不作为源代码提交，也不进入容器构建上下文。
