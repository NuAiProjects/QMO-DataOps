import { useMemo, useState } from "react";
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
import { LoadingState } from "@/components/ui/loading-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/hooks/use-toast";

type ApprovalState = "submitted" | "approved" | "locked";

type ApprovalParticipant = {
  id: string;
  email: string;
  fullName: string;
  attendanceDate: string;
  attendanceStatus: string;
  hoursCredited: string;
};

type ApprovalItem = {
  id: string;
  type: "training" | "attendance" | "attendance_batch";
  state: ApprovalState;
  title: string;
  subtitle: string;
  purpose: string;
  fields: Array<{ label: string; value: string }>;
  returnNotes?: string | null;
  recordIds?: string[];
  participants?: ApprovalParticipant[];
};

function parseApiError(error: unknown) {
  const raw = error instanceof Error ? error.message.replace(/^Error:\s*/, "") : "Request failed.";
  const jsonMatch = raw.match(/\{.*\}$/);
  if (!jsonMatch) return raw;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { message?: string };
    return parsed.message || raw;
  } catch {
    return raw;
  }
}

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
  attendance_batch: "bg-violet-50 text-violet-600 border-violet-200",
};

export default function Approvals() {
  const { toast } = useToast();
  const [returnDialogItem, setReturnDialogItem] = useState<ApprovalItem | null>(null);
  const [returnNotes, setReturnNotes] = useState("");
  const [pendingActionKeys, setPendingActionKeys] = useState<Record<string, boolean>>({});
  const { data, isLoading: approvalsLoading } = useQuery<any>({
    queryKey: ["/api/approvals"],
    queryFn: getQueryFn({ on401: "throw" }),
    refetchOnMount: "always",
  });
  const { data: trainingEventsData, isLoading: trainingsLoading } = useQuery<any>({
    queryKey: ["/api/training-events"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: employeesData, isLoading: employeesLoading } = useQuery<any>({
    queryKey: ["/api/employees"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: unitsData, isLoading: unitsLoading } = useQuery<any>({
    queryKey: ["/api/units"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const training = data?.training ?? { submitted: [], approved: [], locked: [] };
  const attendance = data?.attendance ?? { submitted: [], approved: [], locked: [] };
  const trainingEvents = trainingEventsData?.trainingEvents ?? [];
  const employees = employeesData?.employees ?? [];
  const units = unitsData?.units ?? [];

  const trainingById = useMemo<Map<string, any>>(() => {
    return new Map(trainingEvents.map((event: any) => [event.id, event]));
  }, [trainingEvents]);

  const employeeById = useMemo<Map<string, any>>(() => {
    return new Map(employees.map((employee: any) => [employee.id, employee]));
  }, [employees]);

  const unitById = useMemo<Map<string, any>>(() => {
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
        { label: "Email", value: employee?.email || employee?.employeeNo || "N/A" },
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

  const mapAttendanceBatchItem = (records: any[], state: ApprovalState): ApprovalItem => {
    const firstRecord = records[0];
    const trainingEvent = trainingById.get(firstRecord?.trainingEventId);
    const attendanceDates = Array.from(
      new Set(records.map((record) => formatDate(record.attendanceDate))),
    ).join(", ");
    const participants: ApprovalParticipant[] = records.map((record) => {
      const employee = employeeById.get(record.employeeId);
      return {
        id: record.id,
        email: employee?.email || employee?.employeeNo || "N/A",
        fullName: employee?.fullName || "Unknown employee",
        attendanceDate: formatDate(record.attendanceDate),
        attendanceStatus: formatEnum(record.attendanceStatus),
        hoursCredited: String(record.hoursCredited ?? "N/A"),
      };
    });

    return {
      id: `training-attendance-${firstRecord.trainingEventId}`,
      type: "attendance_batch",
      state,
      title: trainingEvent?.title || "Attendance Submission Batch",
      subtitle: `${participants.length} participant${participants.length === 1 ? "" : "s"} | ${attendanceDates || "N/A"}`,
      purpose:
        "Review the submitted attendance for this training, then approve or return the whole training batch at once.",
      fields: [
        { label: "Record Type", value: "Training Attendance Batch" },
        { label: "Training Event", value: trainingEvent?.title || "Unknown training" },
        { label: "Participants", value: String(participants.length) },
        { label: "Attendance Date(s)", value: attendanceDates || "N/A" },
      ],
      returnNotes: firstRecord.returnNotes,
      recordIds: records.map((record) => record.id),
      participants,
    };
  };

  const submittedAttendanceRecords = attendance.submitted as any[];
  const attendanceBatchMap = new Map<
    string,
    { trainingEventId: string; records: any[]; latestUpdatedAt?: string | null }
  >();

  for (const record of submittedAttendanceRecords) {
    const batchKey = record.trainingEventId;
    const existing = attendanceBatchMap.get(batchKey);
    const recordUpdatedAt = record.updatedAt || record.createdAt || null;
    if (existing) {
      existing.records.push(record);
      const existingTime = existing.latestUpdatedAt ? new Date(existing.latestUpdatedAt).getTime() : 0;
      const nextTime = recordUpdatedAt ? new Date(recordUpdatedAt).getTime() : 0;
      if (nextTime >= existingTime) {
        existing.latestUpdatedAt = recordUpdatedAt;
      }
    } else {
      attendanceBatchMap.set(batchKey, {
        trainingEventId: record.trainingEventId,
        records: [record],
        latestUpdatedAt: recordUpdatedAt,
      });
    }
  }

  const submittedAttendanceBatchItems: ApprovalItem[] = [];
  for (const entry of attendanceBatchMap.values()) {
    submittedAttendanceBatchItems.push(mapAttendanceBatchItem(entry.records, "submitted"));
  }

  submittedAttendanceBatchItems.sort((a, b) => {
    const aTrainingId = a.recordIds?.[0]
      ? submittedAttendanceRecords.find((record) => record.id === a.recordIds?.[0])?.trainingEventId
      : null;
    const bTrainingId = b.recordIds?.[0]
      ? submittedAttendanceRecords.find((record) => record.id === b.recordIds?.[0])?.trainingEventId
      : null;
    const aTime = aTrainingId ? new Date(attendanceBatchMap.get(aTrainingId)?.latestUpdatedAt ?? 0).getTime() : 0;
    const bTime = bTrainingId ? new Date(attendanceBatchMap.get(bTrainingId)?.latestUpdatedAt ?? 0).getTime() : 0;
    return bTime - aTime;
  });

  const pendingItems: ApprovalItem[] = [
    ...training.submitted.map((event: any) => mapTrainingItem(event, "submitted")),
    ...submittedAttendanceBatchItems,
  ];

  const approvedItems: ApprovalItem[] = [
    ...training.approved.map((event: any) => mapTrainingItem(event, "approved")),
    ...attendance.approved.map((record: any) => mapAttendanceItem(record, "approved")),
  ];

  const lockedItems: ApprovalItem[] = [
    ...training.locked.map((event: any) => mapTrainingItem(event, "locked")),
    ...attendance.locked.map((record: any) => mapAttendanceItem(record, "locked")),
  ];
  const isPageLoading = approvalsLoading || trainingsLoading || employeesLoading || unitsLoading;

  if (isPageLoading) {
    return <LoadingState label="Loading approvals..." className="min-h-[420px]" />;
  }

  const getActionKey = (item: ApprovalItem, action: "approve" | "return" | "lock" | "reopen") =>
    `${item.type}:${item.id}:${action}`;

  const isActionPending = (actionKey: string) => Boolean(pendingActionKeys[actionKey]);

  const isItemPending = (item: ApprovalItem) =>
    Object.keys(pendingActionKeys).some((key) => pendingActionKeys[key] && key.startsWith(`${item.type}:${item.id}:`));

  const setActionPending = (actionKey: string, isPending: boolean) => {
    setPendingActionKeys((prev) => {
      if (isPending) {
        return { ...prev, [actionKey]: true };
      }

      const next = { ...prev };
      delete next[actionKey];
      return next;
    });
  };

  const handleApprove = async (item: ApprovalItem) => {
    const actionKey = getActionKey(item, "approve");
    if (isActionPending(actionKey)) return;

    try {
      setActionPending(actionKey, true);
      if (item.type === "training") {
        await apiRequest("POST", `/api/training-events/${item.id}/approve`);
      } else if (item.type === "attendance_batch") {
        await Promise.all(
          (item.recordIds || []).map((recordId) =>
            apiRequest("POST", `/api/attendance/${recordId}/approve`),
          ),
        );
      } else {
        await apiRequest("POST", `/api/attendance/${item.id}/approve`);
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
    } catch (error) {
      await queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
      toast({
        variant: "destructive",
        title: "Failed to approve item",
        description: parseApiError(error),
      });
    } finally {
      setActionPending(actionKey, false);
    }
  };

  const handleReturn = async (item: ApprovalItem, notes: string) => {
    if (!notes.trim()) return;
    const actionKey = getActionKey(item, "return");
    if (isActionPending(actionKey)) return;

    try {
      setActionPending(actionKey, true);
      if (item.type === "training") {
        await apiRequest("POST", `/api/training-events/${item.id}/return`, { notes: notes.trim() });
      } else if (item.type === "attendance_batch") {
        await Promise.all(
          (item.recordIds || []).map((recordId) =>
            apiRequest("POST", `/api/attendance/${recordId}/return`, { notes: notes.trim() }),
          ),
        );
      } else {
        await apiRequest("POST", `/api/attendance/${item.id}/return`, { notes: notes.trim() });
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
    } catch (error) {
      await queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
      toast({
        variant: "destructive",
        title: "Failed to return item",
        description: parseApiError(error),
      });
    } finally {
      setActionPending(actionKey, false);
    }
  };

  const handleLock = async (item: ApprovalItem) => {
    const actionKey = getActionKey(item, "lock");
    if (isActionPending(actionKey)) return;

    try {
      setActionPending(actionKey, true);
      if (item.type === "training") {
        await apiRequest("POST", `/api/training-events/${item.id}/lock`);
      } else {
        await apiRequest("POST", `/api/attendance/${item.id}/lock`);
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
    } catch (error) {
      await queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
      toast({
        variant: "destructive",
        title: "Failed to lock item",
        description: parseApiError(error),
      });
    } finally {
      setActionPending(actionKey, false);
    }
  };

  const handleReopen = async (item: ApprovalItem) => {
    const actionKey = getActionKey(item, "reopen");
    if (isActionPending(actionKey)) return;

    try {
      setActionPending(actionKey, true);
      if (item.type === "training") {
        await apiRequest("POST", `/api/training-events/${item.id}/reopen`);
      } else {
        await apiRequest("POST", `/api/attendance/${item.id}/reopen`);
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
    } catch (error) {
      await queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
      toast({
        variant: "destructive",
        title: "Failed to reopen item",
        description: parseApiError(error),
      });
    } finally {
      setActionPending(actionKey, false);
    }
  };

  const renderItemCard = (item: ApprovalItem) => {
    const approveActionKey = getActionKey(item, "approve");
    const returnActionKey = getActionKey(item, "return");
    const lockActionKey = getActionKey(item, "lock");
    const reopenActionKey = getActionKey(item, "reopen");
    const itemPending = isItemPending(item);

    return (
      <Card key={`${item.type}-${item.id}`} className="border-border/60">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-lg">{item.title}</CardTitle>
              <CardDescription>{item.subtitle}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={typeBadgeClassByType[item.type]}>
                {item.type === "training"
                  ? "Training"
                  : item.type === "attendance_batch"
                    ? "Attendance Batch"
                    : "Attendance"}
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

          {item.type === "attendance_batch" && item.participants && item.participants.length > 0 ? (
            <div className="space-y-2 rounded-md border bg-background p-3">
              <div className="text-sm font-medium">Participants in this batch</div>
              <div className="max-h-64 overflow-y-auto rounded-md border">
                <div className="grid grid-cols-5 gap-2 border-b bg-muted/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>Email</span>
                  <span className="col-span-2">Name</span>
                  <span>Status</span>
                  <span>Hours</span>
                </div>
                {item.participants.map((participant) => (
                  <div
                    key={participant.id}
                    className="grid grid-cols-5 gap-2 border-b px-3 py-2 text-sm last:border-b-0"
                  >
                    <span>{participant.email}</span>
                    <span className="col-span-2">{participant.fullName}</span>
                    <span>{participant.attendanceStatus}</span>
                    <span>{participant.hoursCredited}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

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
                  disabled={itemPending}
                  onClick={() => {
                    setReturnDialogItem(item);
                    setReturnNotes(item.returnNotes || "");
                  }}
                >
                  {isActionPending(returnActionKey) ? (
                    <>
                      <Spinner className="mr-2 h-4 w-4" />
                      Returning...
                    </>
                  ) : (
                    <>
                      <XCircle className="mr-2 h-4 w-4" />
                      Return
                    </>
                  )}
                </Button>
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700"
                  disabled={itemPending}
                  onClick={() => handleApprove(item)}
                >
                  {isActionPending(approveActionKey) ? (
                    <>
                      <Spinner className="mr-2 h-4 w-4" />
                      Approving...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Approve
                    </>
                  )}
                </Button>
              </>
            ) : null}

            {item.state === "approved" ? (
              <Button variant="outline" disabled={itemPending} onClick={() => handleLock(item)}>
                {isActionPending(lockActionKey) ? (
                  <>
                    <Spinner className="mr-2 h-4 w-4" />
                    Locking...
                  </>
                ) : (
                  <>
                    <Lock className="mr-2 h-4 w-4" />
                    Lock
                  </>
                )}
              </Button>
            ) : null}

            {item.state === "locked" ? (
              <Button variant="outline" disabled={itemPending} onClick={() => handleReopen(item)}>
                {isActionPending(reopenActionKey) ? (
                  <>
                    <Spinner className="mr-2 h-4 w-4" />
                    Reopening...
                  </>
                ) : (
                  <>
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Reopen
                  </>
                )}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    );
  };

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

      <Dialog
        open={Boolean(returnDialogItem)}
        onOpenChange={(open) => {
          if (!open) {
            setReturnDialogItem(null);
            setReturnNotes("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Return for Revision</DialogTitle>
            <DialogDescription>
              {returnDialogItem?.type === "attendance_batch"
                ? "Provide clear return notes for the whole attendance batch."
                : "Provide clear return notes for this record."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              value={returnNotes}
              onChange={(event) => setReturnNotes(event.target.value)}
              placeholder="Explain what needs to be corrected."
            />
            <Button
              disabled={
                !returnNotes.trim() ||
                !returnDialogItem ||
                (returnDialogItem
                  ? isItemPending(returnDialogItem)
                  : false)
              }
              onClick={async () => {
                if (!returnDialogItem) return;
                await handleReturn(returnDialogItem, returnNotes);
                setReturnDialogItem(null);
                setReturnNotes("");
              }}
            >
              {returnDialogItem && isActionPending(getActionKey(returnDialogItem, "return")) ? (
                <>
                  <Spinner className="mr-2 h-4 w-4" />
                  Sending...
                </>
              ) : (
                "Send Back"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

