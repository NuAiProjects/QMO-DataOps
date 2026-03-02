import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Download, Eye } from "lucide-react";

type AuditRow = {
  id: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  createdAt: string;
  ip: string | null;
};

function toCsv(rows: AuditRow[]) {
  const headers = ["createdAt", "action", "entityType", "entityId", "actorUserId", "ip"];
  const escapeCell = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((header) =>
          escapeCell(
            header === "createdAt"
              ? new Date(row.createdAt).toISOString()
              : (row as Record<string, unknown>)[header],
          ),
        )
        .join(","),
    );
  }
  return lines.join("\n");
}

export default function Audit() {
  const [entityTypeFilter, setEntityTypeFilter] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [selectedRow, setSelectedRow] = useState<AuditRow | null>(null);

  const { data, isLoading } = useQuery<{ logs: AuditRow[] }>({
    queryKey: ["/api/audit"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const logs = data?.logs ?? [];
  const filteredLogs = useMemo(() => {
    return logs.filter((row) => {
      const matchesEntityType = entityTypeFilter
        ? row.entityType.toLowerCase().includes(entityTypeFilter.toLowerCase())
        : true;
      const haystack = `${row.action} ${row.entityType} ${row.entityId || ""} ${row.actorUserId || ""}`
        .toLowerCase();
      const matchesSearch = searchFilter ? haystack.includes(searchFilter.toLowerCase()) : true;
      return matchesEntityType && matchesSearch;
    });
  }, [logs, entityTypeFilter, searchFilter]);

  if (isLoading) {
    return <LoadingState label="Loading audit logs..." className="min-h-[420px]" />;
  }

  const exportCsv = () => {
    const csv = toCsv(filteredLogs);
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "audit-log-export.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-display font-bold">Audit Log</h1>
          <p className="text-muted-foreground">
            Review system events and export filtered audit entries.
          </p>
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={filteredLogs.length === 0}>
          <Download className="mr-2 h-4 w-4" />
          Export CSV
        </Button>
      </div>

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Narrow logs by entity type and keyword search.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <Input
            value={entityTypeFilter}
            onChange={(event) => setEntityTypeFilter(event.target.value)}
            placeholder="Filter entity type (e.g. training_event)"
          />
          <Input
            value={searchFilter}
            onChange={(event) => setSearchFilter(event.target.value)}
            placeholder="Search action, entity id, actor id"
          />
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle>Entries</CardTitle>
          <CardDescription>{filteredLogs.length} matching audit event(s).</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>IP</TableHead>
                <TableHead className="text-right">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredLogs.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    {new Date(row.createdAt).toLocaleString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </TableCell>
                  <TableCell className="font-medium">{row.action}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{row.entityType}</Badge>
                      <span className="max-w-[200px] truncate text-xs text-muted-foreground">
                        {row.entityId || "-"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-[180px] truncate">{row.actorUserId || "-"}</TableCell>
                  <TableCell>{row.ip || "-"}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => setSelectedRow(row)}>
                      <Eye className="mr-2 h-4 w-4" />
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedRow)} onOpenChange={() => setSelectedRow(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Audit Event Details</DialogTitle>
            <DialogDescription className="sr-only">
              Detailed payload for selected audit row.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">Before</h3>
              <pre className="max-h-[360px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
                {JSON.stringify(selectedRow?.beforeJson ?? null, null, 2)}
              </pre>
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-semibold">After</h3>
              <pre className="max-h-[360px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
                {JSON.stringify(selectedRow?.afterJson ?? null, null, 2)}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
