# Agent Note: 版本化 GUI 欢迎引导

Status: implemented

[English](2026-07-30-versioned-gui-welcome-onboarding.md) | 中文

## 问题

GUI 的凭据引导从 DeepSeek 专用的就绪状态检查开始，但内部测试通知适用于每位用户，即使凭据已经配置，也必须先于提供方设置显示。若把两者作为独立浮层处理，多个对话框可能同时出现；仅存于进程内的关闭标记既无法区分通知已完成确认还是窗口在确认前已关闭，也无法在文案有意修订后重新显示一次通知。

## 决策

**设置外壳协调有序步骤。** `settings.onboarding` 仍是根作用域 list，但 `ui-settings` 会把其中各条目的 id 和顺序投影到一个协调器中，并且只挂载第一个未完成的步骤。当前注册方会收到 `complete()` 和 `openSection(id)`；所有权转移前，不会挂载后续步骤。`ui-settings-models` 以顺序 `0` 注册 DeepSeek 条件式凭据步骤；其共用展示由[共用弹窗引导决策](2026-08-13-shared-modal-product-onboarding.md)持有。

**当前组合不包含产品欢迎步骤。** `ui-settings-general` 仍不注册任何引导步骤；`ui-settings-models` 只持有条件式 DeepSeek 凭据步骤、其文案和共用弹窗。

**凭据引导使用既有 settings 与 credential 服务。** connection 插件通过 `ctx.connection.isLoopback` 统一发布当前页面是否使用 loopback authority；hostname 判定留在 connection 包内，其他客户端插件只消费服务状态，而不导入其实现。提供方凭据继续由 API Proxy 的既有凭据权限路径处理。

**可见引导使用同一个弹窗契约。** 凭据步骤通过 body portal 的同一个 `OnboardingModal` 渲染，且只在弹窗可见期间把下层应用根节点设为 inert。步骤加载私有事实时，外壳不渲染任何包装。明确操作会移交协调器所有权；Escape 和点击遮罩都不会跳过步骤。

## 曾考虑的替代方案

**浏览器本地存储**：不予采用，因为确认状态会跟随某个浏览器 profile，而不是 `$DSH_HOME`；全新的 Harness profile 可能错误继承此前的确认状态，外部 profile 编辑也没有权威更新流。因此，非 loopback 的回退保持为进程内状态，而不是浏览器 profile 状态。

**在 `ui-settings-general` 中再增加一个独立模态窗口**：不予采用，因为欢迎通知和凭据就绪状态同时为真时，list 注册方仍会堆叠。声明并渲染该 list 的外壳应当持有有序所有权。

**在渲染或窗口关闭时持久化**：不予采用，因为看见通知不等于确认，窗口关闭事件也无法可靠送达。只有显式提交「继续」才能阻止通知在下次启动时再次显示。

**通用的公开设置暴露标志**：不予采用，因为一个产品 namespace 不足以证明应当扩大每个 settings 注册方的公开配置面。该 API Proxy 保留显式的封闭允许列表。

## 后果

全新 profile 在没有任何可用提供方时会看到条件式 DeepSeek 密钥弹窗。原有的版本化欢迎确认及其专用 store 不再属于当前客户端组合。定向 React 测试覆盖剩余的条件式移交、共用弹窗行为与 HMR 清理；真实 Chromium 场景验证凭据边界，并检查 secret 未进入 DOM、ARIA 或浏览器控制台。
