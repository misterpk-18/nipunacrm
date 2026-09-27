import { list, post, type PageMeta } from "./client";
import type { DateTime } from "./types";

/** Tabs accepted by GET /notifications?tab= (backend NOTIFICATION_TABS); "My Notifications" = no tab. */
export const NOTIFICATION_TABS = ["Action Required", "Escalations", "Unread", "System Issues", "Completed"] as const;

export type Notification = {
  notification_id: number;
  category: "Action Required" | "Escalation" | "Information" | "System Issue";
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  branch_id: number | null;
  is_action_required: boolean;
  delivered_at: DateTime;
  read_at: DateTime | null;
  acknowledged_at: DateTime | null;
  action_completed_at: DateTime | null;
  warn_at: DateTime | null;
  escalate_at: DateTime | null;
  escalated_at: DateTime | null;
  escalated_from_id: number | null;
  external_channel: string | null;
  external_status: string;
};

export type NotificationMeta = PageMeta & { unread: number };
export type NotificationAction = "read" | "acknowledge" | "complete";

export const notificationsApi = {
  list: async (tab: string | undefined, page = 1) => {
    const result = await list<Notification>("/notifications", { tab, page, per_page: 25 });
    return result as { data: Notification[]; meta: NotificationMeta };
  },
  mark: (id: number, action: NotificationAction) => post<Notification>(`/notifications/${id}/${action}`),
};

/** Prefix shared with the header bell's unread count (["notifications", "unread-count"]). */
export const notificationKeys = {
  all: ["notifications"] as const,
  list: (tab: string | undefined, page: number) => ["notifications", "list", tab ?? "all", page] as const,
};
