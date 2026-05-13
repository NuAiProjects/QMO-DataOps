import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, Download, Eye } from "lucide-react";

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

type AuditPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

type AuditResponse = {
  logs: AuditRow[];
  pagination: AuditPagination;
  filters: {
    from: string;
    to: string;
  };
};

const entityLabelByType: Record<string, string> = {
  auth_session: "Authentication Session",
  user: "User Account",
  employee: "Employee Record",
  training_event: "Training Event",
  attendance_record: "Attendance Record",
  attachment: "File Attachment",
  unit: "Department/Unit",
};

function useDebouncedValue<T>(value: T, delayMs = 350) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [value, delayMs]);

  return debounced;
}

async function fetchAuditLogs(params: URLSearchParams) {
  const res = await fetch(`/api/audit?${params.toString()}`, {
    credentials: "include",
  });
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(text);
  }
  return (await res.json()) as AuditResponse;
}

function formatEntityLabel(entityType: string) {
  return entityLabelByType[entityType] || entityType.replace(/_/g, " ");
}

function formatActionLabel(action: string) {
  const knownActions: Record<string, string> = {
    "auth.login.success": "User signed in successfully",
    "auth.login.failed": "Sign-in attempt failed",
    "auth.logout": "User signed out",
    "auth.password.change": "User changed own password",
    "user.create": "User account created",
    "user.update": "User account updated",
    "user.password.set": "User password set by admin",
    "employee.create": "Employee profile created",
    "employee.update": "Employee profile updated",
    "employee.delete": "Employee profile archived",
    "training_event.create": "Training event created",
    "training_event.update": "Training event updated",
    "training_event.submit": "Training event submitted for approval",
    "training_event.return": "Training event returned for revision",
    "training_event.approve": "Training event approved",
    "training_event.lock": "Training event locked",
    "training_event.reopen": "Training event reopened",
    "attendance_record.create": "Attendance record created",
    "attendance_record.update": "Attendance record updated",
    "attendance_record.submit": "Attendance record submitted for approval",
    "attendance_record.return": "Attendance record returned for revision",
    "attendance_record.approve": "Attendance record approved",
    "attendance_record.lock": "Attendance record locked",
    "attendance_record.reopen": "Attendance record reopened",
  };
  if (knownActions[action]) return knownActions[action];

  const normalized = action.replace(/[._]/g, " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

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
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selectedRow, setSelectedRow] = useState<AuditRow | null>(null);
  const debouncedEntityType = useDebouncedValue(entityTypeFilter);
  const debouncedSearch = useDebouncedValue(searchFilter);

  useEffect(() => {
    setPage(1);
  }, [debouncedEntityType, debouncedSearch, fromDate, toDate, pageSize]);

  const auditParams = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
    });
    if (debouncedEntityType.trim()) {
      params.set("entityType", debouncedEntityType.trim());
    }
    if (debouncedSearch.trim()) {
      params.set("search", debouncedSearch.trim());
    }
    if (fromDate) {
      params.set("from", fromDate);
    }
    if (toDate) {
      params.set("to", toDate);
    }
    return params;
  }, [debouncedEntityType, debouncedSearch, fromDate, page, pageSize, toDate]);

  const { data, error, isFetching, isLoading } = useQuery<AuditResponse>({
    queryKey: ["/api/audit", auditParams.toString()],
    queryFn: () => fetchAuditLogs(auditParams),
  });

  const logs = data?.logs ?? [];
  const pagination = data?.pagination;
  const resultLabel = pagination
    ? pagination.total === 0
      ? "No matching audit events."
      : `Showing ${(pagination.page - 1) * pagination.pageSize + 1}-${Math.min(
          pagination.page * pagination.pageSize,
          pagination.total,
        )} of ${pagination.total} audit event(s).`
    : "Audit events are paginated by the server.";

  if (isLoading) {
    return <LoadingState label="Loading audit logs..." className="min-h-[420px]" />;
  }

  const exportCsv = () => {
    const csv = toCsv(logs);
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
            Review activity history and export filtered records.
          </p>
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={logs.length === 0}>
          <Download className="mr-2 h-4 w-4" />
          Export Page CSV
        </Button>
      </div>

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>Use plain-language filters to find specific activities.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-4">
          <Input
            value={entityTypeFilter}
            onChange={(event) => setEntityTypeFilter(event.target.value)}
            placeholder="Record type"
          />
          <Input
            value={searchFilter}
            onChange={(event) => setSearchFilter(event.target.value)}
            placeholder="Search activity, record id, or actor id"
          />
          <Input
            type="date"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
            aria-label="Audit log from date"
          />
          <Input
            type="date"
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
            aria-label="Audit log to date"
          />
        </CardContent>
      </Card>

      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Audit logs could not be loaded</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : "Please narrow the filters and try again."}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="border-border/60">
        <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle>Entries</CardTitle>
            <CardDescription>
              {resultLabel}
              {isFetching ? " Refreshing..." : ""}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Rows</span>
            <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
              <SelectTrigger className="w-[92px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>What Happened</TableHead>
                <TableHead>Record</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>IP</TableHead>
                <TableHead className="text-right">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((row) => (
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
                  <TableCell className="font-medium">{formatActionLabel(row.action)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="capitalize">
                        {formatEntityLabel(row.entityType)}
                      </Badge>
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
              {logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                    No audit events found for the selected filters.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
          <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="text-sm text-muted-foreground">
              Page {pagination?.page ?? page} of {pagination?.totalPages ?? 1}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={!pagination?.hasPreviousPage || isFetching}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                onClick={() => setPage((current) => current + 1)}
                disabled={!pagination?.hasNextPage || isFetching}
              >
                Next
              </Button>
            </div>
          </div>
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
          <div className="rounded-md border bg-muted/20 p-3 text-sm">
            <div>
              <span className="font-medium">Activity:</span>{" "}
              {selectedRow ? formatActionLabel(selectedRow.action) : "-"}
            </div>
            <div>
              <span className="font-medium">Record Type:</span>{" "}
              {selectedRow ? formatEntityLabel(selectedRow.entityType) : "-"}
            </div>
            <div>
              <span className="font-medium">Record ID:</span> {selectedRow?.entityId || "-"}
            </div>
            <div>
              <span className="font-medium">Actor ID:</span> {selectedRow?.actorUserId || "-"}
            </div>
          </div>
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
