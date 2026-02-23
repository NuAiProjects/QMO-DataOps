import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckCircle2, XCircle, FileText, Lock, RotateCcw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, getQueryFn, queryClient } from "@/lib/queryClient";

type ApprovalState = "submitted" | "approved" | "locked";

type ApprovalItem = {
  id: string;
  type: "training" | "attendance";
  state: ApprovalState;
  title: string;
  subtitle: string;
  purpose: string;
  fields: Array<{ label: string; value: string }>;
  returnNotes?: string | null;
};

const formatDate = (value?: string | null) => {
  if (!value) return "N/A";
  const parsedValue = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value;
  const date = new Date(parsedValue);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
};

const formatDateRange = (startDate?: string | null, endDate?: string | null) => {
  const start = formatDate(startDate);
  const end = formatDate(endDate);
  return start === end ? start : `${start} to ${end}`;
};

const formatEnum = (value?: string | null) => {
  if (!value) return "N/A";
  return value
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
};

const formatStateLabel = (state: ApprovalState) => {
  if (state === "submitted") return "Needs Review";
  if (state === "approved") return "Approved";
  return "Locked";
};

const stateBadgeClassByState: Record<ApprovalState, string> = {
  submitted: "bg-amber-50 text-amber-600 border-amber-200",
  approved: "bg-emerald-50 text-emerald-600 border-emerald-200",
  locked: "bg-slate-100 text-slate-600 border-slate-200",
};

const typeBadgeClassByType: Record<ApprovalItem["type"], string> = {
  training: "bg-blue-50 text-blue-600 border-blue-200",
  attendance: "bg-indigo-50 text-indigo-600 border-indigo-200",
};

export default function Approvals() {
  const { data } = useQuery({
    queryKey: ["/api/approvals"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: trainingEventsData } = useQuery({
    queryKey: ["/api/training-events"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: employeesData } = useQuery({
    queryKey: ["/api/employees"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: unitsData } = useQuery({
    queryKey: ["/api/units"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const training = data?.training ?? { submitted: [], approved: [], locked: [] };
  const attendance = data?.attendance ?? { submitted: [], approved: [], locked: [] };
  const trainingEvents = trainingEventsData?.trainingEvents ?? [];
  const employees = employeesData?.employees ?? [];
  const units = unitsData?.units ?? [];

  const trainingById = useMemo(() => {
    return new Map(trainingEvents.map((event: any) => [event.id, event]));
  }, [trainingEvents]);

  const employeeById = useMemo(() => {
    return new Map(employees.map((employee: any) => [employee.id, employee]));
  }, [employees]);

  const unitById = useMemo(() => {
    return new Map(units.map((unit: any) => [unit.id, unit]));
  }, [units]);

  const mapTrainingItem = (event: any, state: ApprovalState): ApprovalItem => {
    const ownerUnitName = unitById.get(event.ownerUnitId)?.name || "Unknown unit";
    return {
      id: event.id,
      type: "training",
      state,
      title: event.title,
      subtitle: `${formatDateRange(event.startDate, event.endDate)} | ${ownerUnitName}`,
      purpose: "Review event details and confirm this training is ready for workflow progression.",
      fields: [
        { label: "Record Type", value: "Training Event" },
        { label: "Date Range", value: formatDateRange(event.startDate, event.endDate) },
        { label: "Delivery Mode", value: formatEnum(event.deliveryMode) },
        { label: "Hours", value: String(event.hours ?? "N/A") },
        { label: "Category", value: event.category || "N/A" },
        { label: "Provider", value: event.provider || "N/A" },
        { label: "Mandatory", value: event.isMandatory ? "Yes" : "No" },
        { label: "Owner Unit", value: ownerUnitName },
      ],
      returnNotes: event.returnNotes,
    };
  };

  const mapAttendanceItem = (record: any, state: ApprovalState): ApprovalItem => {
    const employee = employeeById.get(record.employeeId);
    const trainingEvent = trainingById.get(record.trainingEventId);
    const unitName =
      unitById.get(employee?.unitId)?.name ||
      unitById.get(trainingEvent?.ownerUnitId)?.name ||
      "Unknown unit";
    return {
      id: record.id,
      type: "attendance",
      state,
      title: employee?.fullName || "Attendance Record",
      subtitle: `${trainingEvent?.title || "Unknown training"} | ${formatDate(record.attendanceDate)}`,
      purpose: "Review attendance details and confirm this participant record is valid.",
      fields: [
        { label: "Record Type", value: "Attendance Record" },
        { label: "Employee No", value: employee?.employeeNo || record.employeeId || "N/A" },
        { label: "Employee Name", value: employee?.fullName || "Unknown employee" },
        { label: "Training Event", value: trainingEvent?.title || "Unknown training" },
        { label: "Attendance Date", value: formatDate(record.attendanceDate) },
        { label: "Attendance Status", value: formatEnum(record.attendanceStatus) },
        { label: "Hours Credited", value: String(record.hoursCredited ?? "N/A") },
        { label: "Unit", value: unitName },
      ],
      returnNotes: record.returnNotes,
    };
  };

  const pendingItems: ApprovalItem[] = [
    ...training.submitted.map((event: any) => mapTrainingItem(event, "submitted")),
    ...attendance.submitted.map((record: any) => mapAttendanceItem(record, "submitted")),
  ];

  const approvedItems: ApprovalItem[] = [
    ...training.approved.map((event: any) => mapTrainingItem(event, "approved")),
    ...attendance.approved.map((record: any) => mapAttendanceItem(record, "approved")),
  ];

  const lockedItems: ApprovalItem[] = [
    ...training.locked.map((event: any) => mapTrainingItem(event, "locked")),
    ...attendance.locked.map((record: any) => mapAttendanceItem(record, "locked")),
  ];

  const handleApprove = async (item: ApprovalItem) => {
    if (item.type === "training") {
      await apiRequest("POST", `/api/training-events/${item.id}/approve`);
    } else {
      await apiRequest("POST", `/api/attendance/${item.id}/approve`);
    }
    queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
  };

  const handleReturn = async (item: ApprovalItem) => {
    const notes = window.prompt("Enter return notes:");
    if (!notes) return;
    if (item.type === "training") {
      await apiRequest("POST", `/api/training-events/${item.id}/return`, { notes });
    } else {
      await apiRequest("POST", `/api/attendance/${item.id}/return`, { notes });
    }
    queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
  };

  const handleLock = async (item: ApprovalItem) => {
    if (item.type === "training") {
      await apiRequest("POST", `/api/training-events/${item.id}/lock`);
    } else {
      await apiRequest("POST", `/api/attendance/${item.id}/lock`);
    }
    queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
  };

  const handleReopen = async (item: ApprovalItem) => {
    if (item.type === "training") {
      await apiRequest("POST", `/api/training-events/${item.id}/reopen`);
    } else {
      await apiRequest("POST", `/api/attendance/${item.id}/reopen`);
    }
    queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
  };

  const renderItemCard = (item: ApprovalItem) => (
    <Card key={`${item.type}-${item.id}`} className="border-border/60">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg">{item.title}</CardTitle>
            <CardDescription>{item.subtitle}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={typeBadgeClassByType[item.type]}>
              {item.type === "training" ? "Training" : "Attendance"}
            </Badge>
            <Badge variant="outline" className={stateBadgeClassByState[item.state]}>
              {formatStateLabel(item.state)}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <FileText className="h-4 w-4" />
            Review purpose
          </div>
          <p className="mt-1">{item.purpose}</p>
        </div>

        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {item.fields.map((field) => (
            <div key={field.label} className="rounded-md border bg-background p-3">
              <div className="text-xs text-muted-foreground">{field.label}</div>
              <div className="mt-1 text-sm font-medium break-words">{field.value}</div>
            </div>
          ))}
        </div>

        {item.returnNotes ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <span className="font-semibold">Return notes:</span> {item.returnNotes}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          {item.state === "submitted" ? (
            <>
              <Button
                variant="outline"
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => handleReturn(item)}
              >
                <XCircle className="mr-2 h-4 w-4" />
                Return
              </Button>
              <Button
                className="bg-emerald-600 hover:bg-emerald-700"
                onClick={() => handleApprove(item)}
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Approve
              </Button>
            </>
          ) : null}

          {item.state === "approved" ? (
            <Button variant="outline" onClick={() => handleLock(item)}>
              <Lock className="mr-2 h-4 w-4" />
              Lock
            </Button>
          ) : null}

          {item.state === "locked" ? (
            <Button variant="outline" onClick={() => handleReopen(item)}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Reopen
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold">Approvals</h1>
        <p className="text-muted-foreground">
          Review and approve training records and attendance submissions.
        </p>
      </div>

      <Tabs defaultValue="pending" className="space-y-4">
        <TabsList>
          <TabsTrigger value="pending">Pending Review</TabsTrigger>
          <TabsTrigger value="approved">Approved</TabsTrigger>
          <TabsTrigger value="locked">Locked</TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="space-y-4">
          {pendingItems.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              No pending approvals.
            </div>
          ) : (
            pendingItems.map((item) => renderItemCard(item))
          )}
        </TabsContent>

        <TabsContent value="approved" className="space-y-4">
          {approvedItems.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">No approved items.</div>
          ) : (
            approvedItems.map((item) => renderItemCard(item))
          )}
        </TabsContent>

        <TabsContent value="locked" className="space-y-4">
          {lockedItems.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">No locked items.</div>
          ) : (
            lockedItems.map((item) => renderItemCard(item))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

