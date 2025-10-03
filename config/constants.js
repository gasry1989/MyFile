// 全局模式相关可调常量（集中修改槽位数量 / 轮询间隔 / 失败阈值）
export const SLOT_COUNT = 12;             // 未来可改为 13 / 14
export const POLL_INTERVAL = 600;        // ms
export const FAIL_THRESHOLD = 5;          // 连续失败次数 => 暂停
export const FAIL_TOAST_PREFIX = '设备无响应数据，已暂停刷新：'; // toast 前缀

// 新增：WS 调试总开关
// 说明：
// 1. 设为 true -> 所有真实 WebSocket 发送/接收 + 代理(iframe)请求/回包 全量打印
// 2. 设为 false -> 可在控制台临时执行 window.__WS_DEBUG__ = true 动态开启
// 3. 运行期也可调用 wsSetDebug(true/false) (见 wsClient.js 导出)
export const WS_LOG_ALL = false;

/* === 新增：视频推流/首帧超时（单位：毫秒） ===
 * 说明：
 * - VIDEO_WS_RESPONSE_TIMEOUT_MS：发送 pushStream 后等待 pushStreamResponse 的时间；超时显示刷新按钮
 * - VIDEO_FIRST_FRAME_TIMEOUT_MS：拿到流地址并开始拉流后，等待首帧（videoWidth>0）的最长时间；超时显示刷新按钮
 * 可按需调整数值
 */
export const VIDEO_WS_RESPONSE_TIMEOUT_MS = 3000;
export const VIDEO_FIRST_FRAME_TIMEOUT_MS = 5000;

// 新增配置常量：站点页面最大逻辑窗口数（含记录 + 手动）
// 如需调整只改这里即可
export const SITE_MAX_WINDOWS = 12;