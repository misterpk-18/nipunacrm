import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { notificationKeys, notificationsApi, NOTIFICATION_TABS, type Notification, type NotificationAction } from "@/api/notifications";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable, Empty, ErrorPanel, LoadingRows, PageHead, Pagination, Status } from "@/components/crm/ui";
import { dateTime } from "@/lib/format";
import { useApiMutation } from "@/lib/mutation";

export type NotificationSearch = { tab?: string; page?: number };
export const ALL_TAB = "My Notifications";

function EntityLink({ n }: { n: Notification }) {
  if (!n.entity_type || !n.entity_id) return null;
  const cls = "text-xs text-primary hover:underline";
  const id = n.entity_id;
  switch (n.entity_type) {
    case "lead":
      return <Link to="/leads/$leadId" params={{ leadId: id }} className={cls}>Open lead</Link>;
    case "invoice":
      return <Link to="/invoices/$invoiceId" params={{ invoiceId: id }} className={cls}>Open invoice</Link>;
    case "payment":
      return <Link to="/payments" className={cls}>Open payments</Link>;
    case "special_closing_request":
      return <Link to="/discount-approval" className={cls}>Open approvals</Link>;
    case "refund_case":
      return <Link to="/refunds" className={cls}>Open refunds</Link>;
    case "task":
      return <Link to="/tasks" className={cls}>Open tasks</Link>;
    case "communication":
      return <Link to="/communications" className={cls}>Open communications</Link>;
    default:
      return <span className="text-xs text-muted-foreground">{n.entity_type.replace(/_/g, " ")} #{id}</span>;
  }
}

const stamp = (value: string | null, yes: string, no: string) =>
  value ? (
    <span>
      <Status kind="good">{yes}</Status>
      <small className="block text-[11px] text-muted-foreground">{dateTime(value)}</small>
    </span>
  ) : (
    <Status kind="neutral">{no}</Status>
  );

/** Notification Centre: delivery, read, acknowledgement and action completion are tracked separately. */
export function NotificationsPage({ search, onSearch }: { search: NotificationSearch; onSearch: (next: NotificationSearch) => void }) {
  const tab = search.tab && (NOTIFICATION_TABS as readonly string[]).includes(search.tab) ? search.tab : undefined;
  const page = search.page ?? 1;
  const notifications = useQuery({ queryKey: notificationKeys.list(tab, page), queryFn: () => notificationsApi.list(tab, page), placeholderData: (prev) => prev });
  const rows = notifications.data?.data;
  const unread = notifications.data?.meta.unread;

  const mark = useApiMutation((v: { id: number; action: NotificationAction }) => notificationsApi.mark(v.id, v.action), {
    success: (n) => (n.action_completed_at ? "Marked complete" : n.acknowledged_at ? "Acknowledged" : "Marked read"),
    invalidate: [notificationKeys.all],
  });

  const actions = (n: Notification) => (
    <div className="flex flex-wrap gap-1">
      {!n.read_at && (
        <Button size="sm" variant="outline" disabled={mark.isPending} onClick={() => mark.mutate({ id: n.notification_id, action: "read" })}>
          Mark read
        </Button>
      )}
      {!n.acknowledged_at && (
        <Button size="sm" variant="outline" disabled={mark.isPending} onClick={() => mark.mutate({ id: n.notification_id, action: "acknowledge" })}>
          Acknowledge
        </Button>
      )}
      {n.is_action_required && !n.action_completed_at && (
        <Button size="sm" disabled={mark.isPending} onClick={() => mark.mutate({ id: n.notification_id, action: "complete" })}>
          Complete
        </Button>
      )}
    </div>
  );

  const event = (n: Notification) => (
    <span className="block min-w-0 max-w-80 whitespace-normal">
      <span className={n.read_at ? "block" : "block font-semibold"}>{n.title}</span>
      {n.body && <span className="block text-xs text-muted-foreground">{n.body}</span>}
      <span className="flex flex-wrap items-center gap-2">
        <Status>{n.category}</Status>
        <EntityLink n={n} />
      </span>
    </span>
  );

  const threshold = (n: Notification) =>
    n.escalated_at ? (
      <Status kind="danger">Escalated {dateTime(n.escalated_at)}</Status>
    ) : n.warn_at || n.escalate_at ? (
      <span className="text-xs">
        {n.warn_at && <span className="block">Warn {dateTime(n.warn_at)}</span>}
        {n.escalate_at && <span className="block">Escalate {dateTime(n.escalate_at)}</span>}
      </span>
    ) : (
      "—"
    );

  return (
    <>
      <PageHead title="Notification Centre" description="Delivery, read, acknowledgement and action completion are separate." />
      <div className="panel">
        <div className="mb-3 text-sm" aria-live="polite">
          {unread !== undefined && (
            <span>
              <b>{unread}</b> unread
            </span>
          )}
        </div>
        <Tabs value={tab ?? ALL_TAB} onValueChange={(t) => onSearch(t === ALL_TAB ? {} : { tab: t })}>
          <TabsList className="mb-4 h-auto max-w-full flex-wrap justify-start overflow-x-auto">
            {[ALL_TAB, ...NOTIFICATION_TABS].map((t) => (
              <TabsTrigger value={t} key={t}>
                {t}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="table-desktop">
          <DataTable
            rows={rows}
            loading={notifications.isLoading}
            error={notifications.error}
            onRetry={() => void notifications.refetch()}
            rowKey={(n) => n.notification_id}
            empty={<Empty title="No notifications">You're all caught up.</Empty>}
            columns={[
              { header: "Event", cell: event },
              { header: "Delivery", cell: (n) => <span>In-app<small className="block text-[11px] text-muted-foreground">{dateTime(n.delivered_at)}</small></span> },
              { header: "Read", cell: (n) => stamp(n.read_at, "Read", "Unread") },
              { header: "Acknowledged", cell: (n) => stamp(n.acknowledged_at, "Acknowledged", "Pending") },
              { header: "Action completed", cell: (n) => (n.is_action_required ? stamp(n.action_completed_at, "Completed", "No") : <span className="text-muted-foreground">No action</span>) },
              { header: "External WhatsApp / email", cell: (n) => <span>{n.external_channel ? `${n.external_channel} · ` : ""}<Status>{n.external_status}</Status></span> },
              { header: "Threshold", cell: threshold },
              { header: "Actions", cell: actions },
            ]}
          />
        </div>
        <div className="mobile-lead-list">
          {notifications.isLoading ? (
            <LoadingRows />
          ) : notifications.error ? (
            <ErrorPanel error={notifications.error} onRetry={() => void notifications.refetch()} />
          ) : rows?.length ? (
            rows.map((n) => (
              <div className="mobile-lead-card space-y-2" key={n.notification_id}>
                {event(n)}
                <div className="text-xs text-muted-foreground">
                  Delivered {dateTime(n.delivered_at)} · {n.read_at ? "Read" : "Unread"} · {n.acknowledged_at ? "Acknowledged" : "Not acknowledged"}
                  {n.is_action_required ? ` · ${n.action_completed_at ? "Action completed" : "Action pending"}` : ""}
                </div>
                {actions(n)}
              </div>
            ))
          ) : (
            <Empty title="No notifications" />
          )}
        </div>
        <Pagination meta={notifications.data?.meta} onPage={(p) => onSearch({ ...search, page: p })} />
        <p className="mt-3 text-xs text-muted-foreground">
          Deduplicated by event occurrence + linked record + recipient + purpose. External WhatsApp / email delivery is shown only when a channel reports it.
        </p>
      </div>
    </>
  );
}
