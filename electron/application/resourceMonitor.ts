// 资源感知调度监控(specs/001-v03 T026 / research R6、契约 C 节不变量 4 资源版)。
//
// 定时(默认 5s)采样 loadavg 与 worktree 根所在卷的磁盘余量,任一维度越过
// 阈值(loadavg[0] > cpuCores × 2,或 freeBytes < settings.minFreeDiskBytes)
// 即置「高压」并推给 ConcurrencyBudget.setResourcePressure——预算闸门对新
// 配额请求拒绝 resource_pressure,运行中已持有的配额不受影响(红线);
// 恢复(false)由预算触发 onCapacityFreed 全局重排。
//
// 探测尽力而为(宪法假设条款):磁盘 statfs 失败(null)→ 该维度不参与判定,
// loadavg 恒可得;仅当两维都不可得时才向预算传 null(探测未知,不阻塞)——
// loadavg 恒在,该分支实际不可达,保留语义与 R6「不放行依据臆造数据」对齐。
// settings.resourcePauseEnabled=false(设置页总闸)时恒传 false,高压只展示
// 不拦截。全部采样/推送都在本进程内存态,不落库;latest() 快照供
// scheduler:resource-status IPC(UI 徽标)与测试读取。

import type { DiskSample, SystemSample } from "../platform/diagnosticsProbes";
import { clampMinFreeDiskBytes, DEFAULT_MIN_FREE_DISK_BYTES } from "../../shared/ipc";

/** 采样节奏:R6 决策的 5s 定时;定时器 unref,不阻塞进程退出。 */
export const DEFAULT_RESOURCE_MONITOR_INTERVAL_MS = 5000;

/** 高压负载倍数:loadavg[0] > cpuCores × LOAD_PRESSURE_FACTOR 判负载高压(R6)。 */
export const LOAD_PRESSURE_FACTOR = 2;

/** 最近一轮采样的只读快照(IPC scheduler:resource-status 载荷)。 */
export interface ResourcePressureSnapshot {
  /** 本轮采样完成时刻(epoch ms);null = 尚未完成第一轮。 */
  sampledAt: number | null;
  loadavg1: number | null;
  cpuCores: number | null;
  /** loadavg[0] > cpuCores × 2;null = 系统采样不可得。 */
  loadHigh: boolean | null;
  /** worktree 根所在卷剩余字节;null = statfs 探测不可得(该维度不参与)。 */
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  /** freeBytes < minFreeDiskBytes;null = 探测不可得(该维度不参与)。 */
  diskLow: boolean | null;
  /** 本轮原始高压判定(负载或磁盘任一命中);null = 两维都不可得。 */
  pressure: boolean | null;
  /** 实际推给预算的值:原始高压 ∧ resourcePauseEnabled;false = 不拦截。 */
  pausingNewTasks: boolean;
}

const EMPTY_SNAPSHOT: ResourcePressureSnapshot = {
  sampledAt: null,
  loadavg1: null,
  cpuCores: null,
  loadHigh: null,
  diskFreeBytes: null,
  diskTotalBytes: null,
  diskLow: null,
  pressure: null,
  pausingNewTasks: false,
};

/** 探针切片(生产注入 DiagnosticsProbes,测试注入 stub)。 */
export interface ResourceMonitorProbes {
  sampleSystem(): SystemSample;
  sampleDisk(path: string): Promise<DiskSample | null>;
}

/** 预算切片:仅需 setResourcePressure(结构兼容 ConcurrencyBudget)。 */
export interface ResourceMonitorBudget {
  setResourcePressure(active: boolean | null): void;
}

/** 设置切片:设置页 scheduler:settings 六键中的资源两键。 */
export interface ResourceMonitorSettings {
  resourcePauseEnabled: boolean;
  minFreeDiskBytes: number;
}

export class ResourceMonitor {
  private readonly probes: ResourceMonitorProbes;
  private readonly budget: ResourceMonitorBudget;
  private readonly paths: { worktreeRoot(): string };
  private readonly settingsProvider: () => ResourceMonitorSettings;
  private readonly intervalMs: number;
  private readonly logger: ((message: string) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 上一轮仍在采样时跳过本轮(statfs 慢于间隔也不堆积)。 */
  private sampling = false;
  private snapshot: ResourcePressureSnapshot = EMPTY_SNAPSHOT;
  /** 上一次推给预算的值;仅状态翻转时打日志。 */
  private lastPushed: boolean | null | undefined;

  constructor(input: {
    probes: ResourceMonitorProbes;
    budget: ResourceMonitorBudget;
    paths: { worktreeRoot(): string };
    settings: () => ResourceMonitorSettings;
    intervalMs?: number;
    logger?: (message: string) => void;
  }) {
    this.probes = input.probes;
    this.budget = input.budget;
    this.paths = input.paths;
    this.settingsProvider = input.settings;
    this.intervalMs = Math.max(50, Math.round(input.intervalMs ?? DEFAULT_RESOURCE_MONITOR_INTERVAL_MS));
    this.logger = input.logger;
  }

  /** 立即采样一轮 + 按间隔定时采样;幂等(已启动时仅补一轮)。 */
  start(): void {
    if (this.timer == null) {
      const timer = setInterval(() => void this.tick(), this.intervalMs);
      // unref:GUI 关窗/mcp-stdio 退出不被采样定时器拖住。
      timer.unref?.();
      this.timer = timer;
    }
    void this.tick();
  }

  stop(): void {
    if (this.timer == null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** 最近一轮采样快照(未采样时 sampledAt=null);纯读,不触发采样。 */
  latest(): ResourcePressureSnapshot {
    return this.snapshot;
  }

  private async tick(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const settings = this.readSettings();
      let system: SystemSample | null = null;
      try {
        system = this.probes.sampleSystem();
      } catch {
        system = null; // sampleSystem 实践上不抛;防御性兜底。
      }
      let disk: DiskSample | null = null;
      try {
        disk = await this.probes.sampleDisk(this.paths.worktreeRoot());
      } catch {
        disk = null; // statfs 失败 → 磁盘维度不参与,不算高压依据。
      }
      const loadHigh = system == null ? null : system.loadavg[0] > system.cpuCores * LOAD_PRESSURE_FACTOR;
      const diskLow = disk == null ? null : disk.freeBytes < settings.minFreeDiskBytes;
      let pressure: boolean | null = null;
      if (loadHigh != null || diskLow != null) {
        pressure = loadHigh === true || diskLow === true;
      }
      // pressure === null 仅当两维都不可得——loadavg 恒可得,实际不会为 null;
      // 保留该三态分支以承载「探测未知不阻塞」语义(R6 尽力而为)。
      const pausingNewTasks = pressure === true && settings.resourcePauseEnabled;
      this.snapshot = {
        sampledAt: Date.now(),
        loadavg1: system?.loadavg[0] ?? null,
        cpuCores: system?.cpuCores ?? null,
        loadHigh,
        diskFreeBytes: disk?.freeBytes ?? null,
        diskTotalBytes: disk?.totalBytes ?? null,
        diskLow,
        pressure,
        pausingNewTasks,
      };
      // 总闸关闭(resourcePauseEnabled=false)时恒传 false:高压只留快照展示,
      // 不进入预算闸门。
      const pushed = pausingNewTasks ? true : pressure === null ? null : false;
      if (pushed !== this.lastPushed) {
        this.logger?.(
          `[ResourceMonitor] pressure=${String(pressure)} loadavg1=${this.snapshot.loadavg1 ?? "?"} ` +
            `cpuCores=${this.snapshot.cpuCores ?? "?"} diskFreeBytes=${this.snapshot.diskFreeBytes ?? "?"} ` +
            `threshold=${settings.minFreeDiskBytes} pausingNewTasks=${pausingNewTasks}`,
        );
        this.lastPushed = pushed;
      }
      this.budget.setResourcePressure(pushed);
    } catch {
      // 采样/推送任一意外失败:保留上一轮快照,下一轮重试(尽力而为)。
    } finally {
      this.sampling = false;
    }
  }

  /** 设置回调现读(高压阈值/总闸即时生效);回调异常回默认值。 */
  private readSettings(): ResourceMonitorSettings {
    try {
      const raw = this.settingsProvider();
      if (raw != null) {
        return {
          resourcePauseEnabled: raw.resourcePauseEnabled !== false,
          minFreeDiskBytes: clampMinFreeDiskBytes(raw.minFreeDiskBytes),
        };
      }
    } catch {
      // fall through to defaults
    }
    return { resourcePauseEnabled: true, minFreeDiskBytes: DEFAULT_MIN_FREE_DISK_BYTES };
  }
}
