// Settings navigation metadata shared by the settings sidebar and the
// detail view (title + one-line description per section).

import { Bot, Cog, Palette, PenLine, Plug, ShieldCheck, type LucideIcon } from "lucide-react";

export type SettingsSection = "general" | "appearance" | "agents" | "connections" | "gate" | "custom";

export interface SettingsSectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  {
    id: "general",
    label: "常规",
    icon: Cog,
    description: "管理应用的基础行为、启动项与 Worktree 磁盘维护。",
  },
  {
    id: "appearance",
    label: "外观",
    icon: Palette,
    description: "调整应用界面主题与代码块高亮主题。",
  },
  {
    id: "agents",
    label: "外部 Agent",
    icon: Bot,
    description: "管理可委派的外部 Agent 执行器：启用/停用、配置可执行文件与检测。",
  },
  {
    id: "connections",
    label: "连接与 MCP",
    icon: Plug,
    description: "管理 OctoPunk 作为 MCP 服务器的接入方式与外部连接（STDIO / HTTP）。",
  },
  {
    id: "gate",
    label: "质量门禁",
    icon: ShieldCheck,
    description: "按仓库配置质量门禁：命令检查、风险阈值、变更范围与审查模式。",
  },
  {
    id: "custom",
    label: "自定义",
    icon: PenLine,
    description: "向此主机上的所有子 Agent 任务注入全局自定义指令。",
  },
] as const;
