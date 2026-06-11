import { useGetStats, getGetStatsQueryKey } from "@workspace/api-client-react";
import { format } from "date-fns";
import { Link } from "wouter";
import { Activity, Clock, CheckCircle, XCircle, ArrowRight, RefreshCw } from "lucide-react";

export default function Stats() {
  const { data: stats, isLoading, refetch } = useGetStats({}, { query: { queryKey: getGetStatsQueryKey() } });

  const successRate = stats?.totalRequests
    ? Math.round((stats.successCount / stats.totalRequests) * 100)
    : 0;

  return (
    <div className="flex-1 flex flex-col overflow-auto bg-background">
      <div className="bg-card border-b border-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-foreground">Statistics</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Gateway usage metrics and performance overview</p>
          </div>
          <button
            onClick={() => refetch()}
            data-testid="btn-refresh-stats"
            className="flex items-center gap-2 px-4 py-2 border border-border text-sm rounded hover:bg-muted transition-colors text-muted-foreground"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      <div className="flex-1 p-6 max-w-5xl mx-auto w-full space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">Loading...</div>
        ) : (
          <>
            {/* Metric cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-card border border-border rounded-lg p-5" data-testid="stat-total-requests">
                <div className="flex items-center gap-2 text-muted-foreground mb-3">
                  <Activity className="w-4 h-4" />
                  <span className="text-xs font-semibold uppercase tracking-wider">Total Requests</span>
                </div>
                <div className="text-4xl font-bold text-foreground">{stats?.totalRequests ?? 0}</div>
              </div>

              <div className="bg-card border border-border rounded-lg p-5" data-testid="stat-success-rate">
                <div className="flex items-center gap-2 text-muted-foreground mb-3">
                  <CheckCircle className="w-4 h-4" />
                  <span className="text-xs font-semibold uppercase tracking-wider">Success Rate</span>
                </div>
                <div className="text-4xl font-bold text-foreground">{successRate}%</div>
                <div className="text-xs text-muted-foreground mt-1">{stats?.successCount ?? 0} successful</div>
              </div>

              <div className="bg-card border border-border rounded-lg p-5" data-testid="stat-avg-latency">
                <div className="flex items-center gap-2 text-muted-foreground mb-3">
                  <Clock className="w-4 h-4" />
                  <span className="text-xs font-semibold uppercase tracking-wider">Avg Latency</span>
                </div>
                <div className="text-4xl font-bold text-foreground">
                  {stats?.avgResponseTime ?? 0}
                  <span className="text-lg font-normal text-muted-foreground ml-1">ms</span>
                </div>
              </div>

              <div className="bg-card border border-border rounded-lg p-5" data-testid="stat-failures">
                <div className="flex items-center gap-2 text-muted-foreground mb-3">
                  <XCircle className="w-4 h-4" />
                  <span className="text-xs font-semibold uppercase tracking-wider">Failures</span>
                </div>
                <div className="text-4xl font-bold text-foreground">{stats?.failureCount ?? 0}</div>
              </div>
            </div>

            {/* System info */}
            <div className="bg-card border border-border rounded-lg overflow-hidden">
              <div className="px-5 py-3 border-b border-border bg-muted/40">
                <h2 className="text-sm font-semibold text-foreground">Gateway Information</h2>
              </div>
              <div className="divide-y divide-border">
                <div className="grid grid-cols-[180px_1fr] px-5 py-3">
                  <div className="text-sm text-muted-foreground font-medium">Status</div>
                  <div className="text-sm flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-foreground/50" />
                    <span className="text-foreground font-semibold">Online</span>
                  </div>
                </div>
                <div className="grid grid-cols-[180px_1fr] px-5 py-3">
                  <div className="text-sm text-muted-foreground font-medium">Target API</div>
                  <div className="text-sm font-mono text-foreground">
                    <span className="text-muted-foreground text-xs">upstream →</span>{" "}
                    https://chat.qwen.ai/api/v2
                  </div>
                </div>
                <div className="grid grid-cols-[180px_1fr] px-5 py-3">
                  <div className="text-sm text-muted-foreground font-medium">Last Request</div>
                  <div className="text-sm text-foreground font-mono" data-testid="stat-last-request">
                    {stats?.lastRequestAt ? format(new Date(stats.lastRequestAt), "yyyy-MM-dd HH:mm:ss") : "No requests yet"}
                  </div>
                </div>
                <div className="grid grid-cols-[180px_1fr] px-5 py-3">
                  <div className="text-sm text-muted-foreground font-medium">Supported Methods</div>
                  <div className="flex gap-2">
                    <span className="method-badge-get">GET</span>
                    <span className="method-badge-post">POST</span>
                    <span className="method-badge-put">PUT</span>
                    <span className="method-badge-delete">DELETE</span>
                  </div>
                </div>
                <div className="grid grid-cols-[180px_1fr] px-5 py-3">
                  <div className="text-sm text-muted-foreground font-medium">History Limit</div>
                  <div className="text-sm text-foreground">Unlimited (in-memory)</div>
                </div>
              </div>
            </div>

            {/* Progress bar */}
            {(stats?.totalRequests ?? 0) > 0 && (
              <div className="bg-card border border-border rounded-lg p-5 space-y-3">
                <h2 className="text-sm font-semibold text-foreground">Success / Failure Breakdown</h2>
                <div className="h-3 rounded-full overflow-hidden bg-muted border border-border">
                  <div className="h-full bg-foreground/70 transition-all" style={{ width: `${successRate}%` }} />
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{stats?.successCount} success</span>
                  <span>{stats?.failureCount} failed</span>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <Link href="/history">
                <button data-testid="link-view-history"
                  className="flex items-center gap-2 px-5 py-2.5 border border-border text-sm rounded hover:bg-muted transition-colors text-foreground">
                  View Full History <ArrowRight className="w-4 h-4" />
                </button>
              </Link>
              <Link href="/playground">
                <button data-testid="link-playground"
                  className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm rounded hover:opacity-90 transition-opacity">
                  Go to Playground <ArrowRight className="w-4 h-4" />
                </button>
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
