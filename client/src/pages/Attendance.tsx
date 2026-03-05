import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Upload, Save, CheckCircle, Search, Check, ChevronsUpDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, getQueryFn, queryClient } from "@/lib/queryClient";
import { useUser } from "@/hooks/use-user";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";

type AttendanceRow = {
  id: string;
  employeeId: string;
  trainingEventId: string;
  attendanceDate: string;
  attendanceStatus: string;
  workflowStatus: string;
};

export default function Attendance() {
  const { user } = useUser();
  const { toast } = useToast();
  const [selectedEventId, setSelectedEventId] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [importBatch, setImportBatch] = useState<any | null>(null);
  const [importRows, setImportRows] = useState<any[]>([]);
  const [decisionMap, setDecisionMap] = useState<Record<string, "skip" | "update">>({});
  const [resolveMap, setResolveMap] = useState<Record<string, string>>({});
  const [invalidResolveMap, setInvalidResolveMap] = useState<Record<string, boolean>>({});
  const [uploading, setUploading] = useState(false);
  const [submittingAll, setSubmittingAll] = useState(false);
  const csvFileInputRef = useRef<HTMLInputElement | null>(null);
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [archiveRow, setArchiveRow] = useState<AttendanceRow | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [manualForm, setManualForm] = useState({
    employeeId: "",
    attendanceDate: "",
    hoursCredited: "0",
    attendanceStatus: "present",
  });

  const { data: trainingData, isLoading: trainingsLoading } = useQuery({
    queryKey: ["/api/training-events"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: employeeData, isLoading: employeesLoading } = useQuery({
    queryKey: ["/api/employees"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const events = trainingData?.trainingEvents ?? [];
  const activeEvents = events.filter((event: any) => event.workflowStatus !== "draft");
  const selectedEvent = events.find((event: any) => event.id === selectedEventId);

  const { data: attendanceData, refetch: refetchAttendance, isLoading: attendanceLoading } = useQuery({
    queryKey: ["/api/attendance", selectedEventId],
    queryFn: async () => {
      if (!selectedEventId) return { attendance: [] };
      const res = await fetch(`/api/attendance?trainingEventId=${selectedEventId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load attendance.");
      return res.json();
    },
    enabled: !!selectedEventId,
  });

  const attendance = attendanceData?.attendance ?? [];
  const employees = employeeData?.employees ?? [];
  const isPageLoading = trainingsLoading || employeesLoading;
  const role = user?.role || "";
  const canSubmit = ["encoder", "unit_head", "super_admin"].includes(role);
  const canManageAttendance = ["encoder", "unit_head", "super_admin", "hr_qa_approver"].includes(
    role,
  );
  const canBulkImport = ["encoder", "unit_head", "super_admin"].includes(role);
  const selectedManualEmployee = employees.find((emp: any) => emp.id === manualForm.employeeId);

  const employeeMap = useMemo(() => {
    const map = new Map<string, any>();
    employees.forEach((emp: any) => {
      map.set(emp.id, emp);
    });
    return map;
  }, [employees]);

  const duplicateKeySet = useMemo(() => {
    const set = new Set<string>();
    (attendance as AttendanceRow[]).forEach((row) => {
      set.add(`${row.employeeId}:${row.attendanceDate}`);
    });
    return set;
  }, [attendance]);

  const filteredAttendance = attendance.filter((row: AttendanceRow) => {
    const emp = employeeMap.get(row.employeeId);
    const haystack = `${emp?.fullName ?? ""} ${emp?.employeeNo ?? ""}`.toLowerCase();
    return haystack.includes(searchTerm.toLowerCase());
  });

  const submittableRows = useMemo(
    () =>
      (attendance as AttendanceRow[]).filter((row) =>
        ["draft", "returned"].includes(row.workflowStatus),
      ),
    [attendance],
  );

  const getRowField = (row: Record<string, string>, keys: string[]) => {
    for (const key of keys) {
      if (row[key]) return row[key];
    }
    return "";
  };
  const getResponseMessage = async (res: Response) => {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") return parsed.message;
    } catch {
      // Ignore JSON parse errors and use the raw text instead.
    }
    return text || "Request failed.";
  };

  useEffect(() => {
    setImportBatch(null);
    setImportRows([]);
    setDecisionMap({});
    setResolveMap({});
    setInvalidResolveMap({});
  }, [selectedEventId]);

  useEffect(() => {
    if (!selectedEvent) return;
    setManualForm((prev) => ({
      ...prev,
      hoursCredited: prev.hoursCredited === "0" ? String(selectedEvent.hours) : prev.hoursCredited,
    }));
  }, [selectedEvent?.id, selectedEvent?.hours]);

  const handleCsvUpload = async (file: File) => {
    if (!canBulkImport) return;
    if (!selectedEventId) return;
    try {
      setUploading(true);
      const form = new FormData();
      form.append("file", file);
      form.append("trainingEventId", selectedEventId);
      const res = await fetch("/api/attendance/import", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(await getResponseMessage(res));
      }
      const data = await res.json();
      setImportBatch(data.batch);
      setImportRows(data.rows);
      setDecisionMap({});
      setResolveMap({});
      setInvalidResolveMap({});
      toast({
        title: "CSV uploaded",
        description: "Review matched rows, resolve unmatched entries, then commit import.",
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "CSV upload failed",
        description: error instanceof Error ? error.message : "Unable to upload CSV.",
      });
    } finally {
      setUploading(false);
    }
  };

  const handleResolve = async () => {
    if (!canManageAttendance) return;
    if (!importBatch) return;
    const resolutionRowIds = new Set([
      ...Object.keys(resolveMap),
      ...Object.keys(invalidResolveMap).filter((rowId) => invalidResolveMap[rowId]),
    ]);
    const resolutions = Array.from(resolutionRowIds).map((rowId) => ({
      rowId,
      employeeId: resolveMap[rowId],
      markInvalid: invalidResolveMap[rowId] || false,
    }));
    if (resolutions.length === 0) return;
    const res = await apiRequest("POST", `/api/attendance/import/${importBatch.id}/resolve`, {
      resolutions,
    });
    const data = await res.json();
    setImportRows(data.rows);
    setResolveMap({});
    setInvalidResolveMap({});
  };

  const handleCommit = async () => {
    if (!canManageAttendance) return;
    if (!importBatch) return;
    const decisions = Object.entries(decisionMap).map(([rowId, action]) => ({
      rowId,
      action,
    }));
    await apiRequest("POST", `/api/attendance/import/${importBatch.id}/commit`, {
      decisions,
    });
    setImportBatch(null);
    setImportRows([]);
    setDecisionMap({});
    setResolveMap({});
    setInvalidResolveMap({});
    await refetchAttendance();
  };

  const handleManualCreate = async () => {
    if (!canManageAttendance) return;
    if (!selectedEventId) return;
    if (!manualForm.employeeId) {
      toast({
        variant: "destructive",
        title: "Employee is required.",
      });
      return;
    }
    if (!manualForm.attendanceDate) {
      toast({
        variant: "destructive",
        title: "Attendance date is required.",
      });
      return;
    }
    const parsedHours = Number(manualForm.hoursCredited);
    if (Number.isNaN(parsedHours) || parsedHours < 0) {
      toast({
        variant: "destructive",
        title: "Hours credited must be a valid non-negative number.",
      });
      return;
    }
    await apiRequest("POST", "/api/attendance", {
      trainingEventId: selectedEventId,
      employeeId: manualForm.employeeId,
      attendanceDate: manualForm.attendanceDate,
      hoursCredited: parsedHours,
      attendanceStatus: manualForm.attendanceStatus,
    });
    setManualOpen(false);
    setManualForm({
      employeeId: "",
      attendanceDate: "",
      hoursCredited: selectedEvent ? String(selectedEvent.hours) : "0",
      attendanceStatus: "present",
    });
    await refetchAttendance();
  };

  const submitAttendance = async (attendanceId: string) => {
    await apiRequest("POST", `/api/attendance/${attendanceId}/submit`);
    await queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
    await refetchAttendance();
  };

  const archiveAttendance = async () => {
    if (!archiveRow) return;
    await apiRequest("DELETE", `/api/attendance/${archiveRow.id}`, {
      reason: archiveReason.trim(),
    });
    setArchiveDialogOpen(false);
    setArchiveRow(null);
    setArchiveReason("");
    await refetchAttendance();
  };

  const submitAllAttendance = async () => {
    if (submittableRows.length === 0) return;
    try {
      setSubmittingAll(true);
      const results = await Promise.allSettled(
        submittableRows.map((row) => apiRequest("POST", `/api/attendance/${row.id}/submit`)),
      );
      const submitted = results.filter((result) => result.status === "fulfilled").length;
      const failed = results.length - submitted;
      await queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
      await refetchAttendance();
      if (failed === 0) {
        toast({
          title: `Submitted ${submitted} attendance record${submitted === 1 ? "" : "s"}.`,
        });
      } else {
        toast({
          variant: "destructive",
          title: "Submit all completed with errors",
          description: `Submitted: ${submitted}, Failed: ${failed}`,
        });
      }
    } finally {
      setSubmittingAll(false);
    }
  };

  if (isPageLoading) {
    return <LoadingState label="Loading attendance data..." className="min-h-[420px]" />;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold">Attendance Recording</h1>
        <p className="text-muted-foreground">Record participation for training events.</p>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="md:col-span-1 h-fit border-border/60">
          <CardHeader>
            <CardTitle>Select Event</CardTitle>
            <CardDescription>Choose a training to record attendance for</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Select value={selectedEventId} onValueChange={setSelectedEventId}>
              <SelectTrigger>
                <SelectValue placeholder="Select event..." />
              </SelectTrigger>
              <SelectContent>
                {activeEvents.map((training: any) => (
                  <SelectItem key={training.id} value={training.id}>
                    {training.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {selectedEvent && (
              <div className="rounded-md bg-muted/30 p-4 text-sm space-y-2 border">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Date:</span>
                  <span className="font-medium">{selectedEvent.startDate}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Mode:</span>
                  <span className="font-medium">{selectedEvent.deliveryMode}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Hours:</span>
                  <span className="font-medium">{selectedEvent.hours}</span>
                </div>
                <div className="pt-2">
                  <Badge variant="outline" className="w-full justify-center">
                    {selectedEvent.workflowStatus}
                  </Badge>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2 border-border/60">
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <CardTitle>Attendance Sheet</CardTitle>
              <CardDescription className="break-words">
                {selectedEvent ? `Recording for: ${selectedEvent.title}` : "Select an event to start"}
              </CardDescription>
            </div>
            {selectedEvent && (
              <div className="flex w-full flex-wrap gap-2 md:w-auto md:flex-shrink-0 md:justify-end">
                {canSubmit && submittableRows.length > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={submitAllAttendance}
                    disabled={submittingAll}
                  >
                    {submittingAll ? (
                      <>
                        <Spinner className="mr-2 h-4 w-4" />
                        Submitting...
                      </>
                    ) : (
                      `Submit All (${submittableRows.length})`
                    )}
                  </Button>
                ) : null}
                {canBulkImport ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={uploading}
                      onClick={() => csvFileInputRef.current?.click()}
                    >
                      {uploading ? (
                        <>
                          <Spinner className="mr-2 h-4 w-4" />
                          Uploading...
                        </>
                      ) : (
                        <>
                          <Upload className="mr-2 h-4 w-4" />
                          Bulk Upload CSV
                        </>
                      )}
                    </Button>
                    <input
                      ref={csvFileInputRef}
                      type="file"
                      className="hidden"
                      accept=".csv"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleCsvUpload(file);
                        e.currentTarget.value = "";
                      }}
                    />
                  </>
                ) : null}
                {canManageAttendance ? (
                  <>
                    <Dialog
                      open={manualOpen}
                      onOpenChange={(open) => {
                        setManualOpen(open);
                        if (open && selectedEvent) {
                          setManualForm((prev) => ({
                            ...prev,
                            hoursCredited: String(selectedEvent.hours),
                          }));
                        }
                      }}
                    >
                      <DialogTrigger asChild>
                        <Button variant="outline" size="sm">
                          Add Attendance
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Manual Attendance</DialogTitle>
                          <DialogDescription className="sr-only">
                            Add a single attendance record for the selected training.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <label className="text-sm font-medium">Employee</label>
                            <Popover open={employeePickerOpen} onOpenChange={setEmployeePickerOpen}>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  role="combobox"
                                  className="w-full justify-between font-normal"
                                >
                                  {selectedManualEmployee
                                    ? `${selectedManualEmployee.employeeNo} - ${selectedManualEmployee.fullName}`
                                    : "Search employee"}
                                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
                                <Command>
                                  <CommandInput placeholder="Search employee..." />
                                  <CommandList className="max-h-64">
                                    <CommandEmpty>No matching employee.</CommandEmpty>
                                    <CommandGroup>
                                      {employees.map((emp: any) => (
                                        <CommandItem
                                          key={emp.id}
                                          value={`${emp.employeeNo} ${emp.fullName}`}
                                          onSelect={() => {
                                            setManualForm((prev) => ({ ...prev, employeeId: emp.id }));
                                            setEmployeePickerOpen(false);
                                          }}
                                        >
                                          <Check
                                            className={cn(
                                              "mr-2 h-4 w-4",
                                              manualForm.employeeId === emp.id
                                                ? "opacity-100"
                                                : "opacity-0",
                                            )}
                                          />
                                          {emp.employeeNo} - {emp.fullName}
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  </CommandList>
                                </Command>
                              </PopoverContent>
                            </Popover>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-sm font-medium">Attendance Date</label>
                            <Input
                              type="date"
                              value={manualForm.attendanceDate}
                              onChange={(e) =>
                                setManualForm((prev) => ({
                                  ...prev,
                                  attendanceDate: e.target.value,
                                }))
                              }
                            />
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-sm font-medium">Hours Credited</label>
                            <Input
                              type="number"
                              step="0.25"
                              min="0"
                              placeholder="e.g. 3"
                              value={manualForm.hoursCredited}
                              onChange={(e) =>
                                setManualForm((prev) => ({
                                  ...prev,
                                  hoursCredited: e.target.value,
                                }))
                              }
                            />
                            <p className="text-xs text-muted-foreground">
                              Used for hour reports. Default is the selected event hours.
                            </p>
                          </div>

                          <div className="space-y-1.5">
                            <label className="text-sm font-medium">Status</label>
                            <Select
                              value={manualForm.attendanceStatus}
                              onValueChange={(value) =>
                                setManualForm((prev) => ({
                                  ...prev,
                                  attendanceStatus: value,
                                }))
                              }
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Status" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="present">Present</SelectItem>
                                <SelectItem value="absent">Absent</SelectItem>
                                <SelectItem value="partial">Partial</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <Button onClick={handleManualCreate}>Save Attendance</Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  </>
                ) : null}
                {canManageAttendance && importBatch && (
                  <Button size="sm" onClick={handleCommit}>
                    <Save className="mr-2 h-4 w-4" />
                    Commit Import
                  </Button>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent>
            {!selectedEvent ? (
              <div className="flex flex-col items-center justify-center h-[300px] text-muted-foreground border-2 border-dashed rounded-lg">
                <CheckCircle className="h-10 w-10 mb-4 opacity-20" />
                <p>Please select an event to manage attendance</p>
              </div>
            ) : attendanceLoading ? (
              <LoadingState label="Loading attendance records..." className="min-h-[320px]" />
            ) : (
              <div className="space-y-6">
                {canBulkImport ? (
                  <p className="text-xs text-muted-foreground">
                    CSV schema required:{" "}
                    <span className="font-medium">
                      Email, Participants, Date, Title (must match selected event)
                    </span>
                  </p>
                ) : null}

                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search employee..."
                    className="pl-9"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>

                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Employee</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredAttendance.map((row: AttendanceRow) => {
                        const emp = employeeMap.get(row.employeeId);
                        return (
                          <TableRow key={row.id}>
                            <TableCell>
                              <div className="font-medium">{emp?.fullName ?? "Unknown"}</div>
                              <div className="text-xs text-muted-foreground">{emp?.employeeNo ?? "—"}</div>
                            </TableCell>
                            <TableCell>{row.attendanceDate}</TableCell>
                            <TableCell>
                              <Badge variant="outline">{row.workflowStatus}</Badge>
                            </TableCell>
                                                        <TableCell>
                              <div className="flex items-center gap-2">
                                {canSubmit && ["draft", "returned"].includes(row.workflowStatus) ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={submittingAll}
                                    onClick={() => submitAttendance(row.id)}
                                  >
                                    Submit
                                  </Button>
                                ) : null}
                                {canManageAttendance ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="text-destructive"
                                    onClick={() => {
                                      setArchiveRow(row);
                                      setArchiveReason("");
                                      setArchiveDialogOpen(true);
                                    }}
                                  >
                                    Archive
                                  </Button>
                                ) : null}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {importBatch ? (
                  <div className="space-y-4">
                    <div className="rounded-md border border-border/70 p-4 text-sm">
                      <div className="font-medium">Import Summary</div>
                      <div className="text-muted-foreground">
                        Total: {importBatch.summaryJson?.total ?? importRows.length} · Matched: {importBatch.summaryJson?.matched ?? 0} · Unmatched: {importBatch.summaryJson?.unmatched ?? 0} · Invalid: {importBatch.summaryJson?.invalid ?? 0}
                      </div>
                    </div>

                    <div className="rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Email</TableHead>
                            <TableHead>Participants</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Resolution</TableHead>
                            <TableHead>Duplicate</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {importRows.map((row) => {
                            const raw = row.rawRowJson || {};
                            const attendanceDate = getRowField(raw, [
                              "Date",
                              "attendance_date",
                              "attendanceDate",
                              "Attendance Date",
                              "attendance date",
                            ]);
                            const participants = getRowField(raw, ["Participants"]);
                            const email = getRowField(raw, ["Email", "email"]);
                            const key = row.resolvedEmployeeId
                              ? `${row.resolvedEmployeeId}:${attendanceDate}`
                              : "";
                            const isDuplicate = key && duplicateKeySet.has(key);
                            return (
                              <TableRow key={row.id}>
                                <TableCell>{email || "-"}</TableCell>
                                <TableCell>{participants || "-"}</TableCell>
                                <TableCell>{attendanceDate || "-"}</TableCell>
                                <TableCell>
                                  <Badge variant="outline">{row.matchStatus}</Badge>
                                </TableCell>
                                <TableCell>
                                  {row.matchStatus === "unmatched" ? (
                                    <div className="space-y-2">
                                      <Select
                                        value={resolveMap[row.id] || ""}
                                        onValueChange={(value) =>
                                          setResolveMap((prev) => ({ ...prev, [row.id]: value }))
                                        }
                                        disabled={invalidResolveMap[row.id] === true}
                                      >
                                        <SelectTrigger>
                                          <SelectValue placeholder="Match employee" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {employees.map((emp: any) => (
                                            <SelectItem key={emp.id} value={emp.id}>
                                              {emp.employeeNo} - {emp.fullName}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <Checkbox
                                          checked={invalidResolveMap[row.id] === true}
                                          onCheckedChange={(checked) =>
                                            setInvalidResolveMap((prev) => ({
                                              ...prev,
                                              [row.id]: checked === true,
                                            }))
                                          }
                                        />
                                        Mark as invalid
                                      </label>
                                    </div>
                                  ) : (
                                    <span className="text-muted-foreground">-</span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  {isDuplicate ? (
                                    <Select
                                      value={decisionMap[row.id] || ""}
                                      onValueChange={(value: "skip" | "update") =>
                                        setDecisionMap((prev) => ({ ...prev, [row.id]: value }))
                                      }
                                    >
                                      <SelectTrigger>
                                        <SelectValue placeholder="Choose" />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="skip">Skip</SelectItem>
                                        <SelectItem value="update">Update</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  ) : (
                                    <span className="text-muted-foreground">—</span>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>

                    {canManageAttendance ? (
                      <div className="flex justify-end">
                        <Button variant="outline" onClick={handleResolve}>
                          Resolve Unmatched
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive Attendance Record</DialogTitle>
            <DialogDescription>
              Provide a reason before archiving this attendance record.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              placeholder="Reason for archive"
              value={archiveReason}
              onChange={(event) => setArchiveReason(event.target.value)}
            />
            <Button
              variant="destructive"
              disabled={archiveReason.trim().length < 3}
              onClick={archiveAttendance}
            >
              Archive Record
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}


