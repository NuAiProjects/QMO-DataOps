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
import { Textarea } from "@/components/ui/textarea";

type AttendanceRow = {
  id: string;
  employeeId: string;
  trainingEventId: string;
  attendanceDate: string;
  attendanceStatus: string;
  workflowStatus: string;
};

type AttendanceDisplayRow = AttendanceRow & {
  source: "record" | "import_preview";
  importRowId?: string;
};

const IMPORT_REVIEW_PAGE_SIZE = 25;

function toIsoAttendanceDate(year: number, month: number, day: number) {
  const iso = `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return iso;
}

function normalizeAttendancePreviewDate(input: string | null | undefined) {
  const value = (input ?? "").trim();
  if (!value) return null;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (isoMatch) {
    return toIsoAttendanceDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  if (slashMatch) {
    const rawYear = Number(slashMatch[3]);
    const year = slashMatch[3].length === 2 ? 2000 + rawYear : rawYear;
    return toIsoAttendanceDate(year, Number(slashMatch[1]), Number(slashMatch[2]));
  }

  const dashMatch = /^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/.exec(value);
  if (dashMatch) {
    const rawYear = Number(dashMatch[3]);
    const year = dashMatch[3].length === 2 ? 2000 + rawYear : rawYear;
    return toIsoAttendanceDate(year, Number(dashMatch[1]), Number(dashMatch[2]));
  }

  const textMonthMatch = /^(\d{1,2})-([a-zA-Z]{3,9})-(\d{2}|\d{4})$/.exec(value);
  if (textMonthMatch) {
    const monthKey = textMonthMatch[2].toLowerCase().slice(0, 3);
    const monthMap: Record<string, number> = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12,
    };
    const month = monthMap[monthKey];
    if (!month) return null;
    const rawYear = Number(textMonthMatch[3]);
    const year = textMonthMatch[3].length === 2 ? 2000 + rawYear : rawYear;
    return toIsoAttendanceDate(year, month, Number(textMonthMatch[1]));
  }

  return null;
}

function parseAttendancePreviewDates(input: string | null | undefined) {
  const value = (input ?? "").trim();
  if (!value) return [];

  const collapsedValue = value.replace(/\s+/g, " ").trim();
  const rangeMatch =
    /^(.+?)\s+(?:to)\s+(.+)$/i.exec(collapsedValue) ||
    /^(.+?)\s*(?:-|–|—)\s*(.+)$/.exec(collapsedValue);

  if (rangeMatch) {
    const startIso = normalizeAttendancePreviewDate(rangeMatch[1]);
    const endIso = normalizeAttendancePreviewDate(rangeMatch[2]);
    if (!startIso || !endIso) return [];

    const start = new Date(`${startIso}T00:00:00.000Z`);
    const end = new Date(`${endIso}T00:00:00.000Z`);
    if (start.getTime() > end.getTime()) return [];

    const diffDays = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
    const useWeeklyStep = diffDays >= 7 && start.getUTCDay() === end.getUTCDay();
    const stepDays = useWeeklyStep ? 7 : 1;
    const dates: string[] = [];
    const cursor = new Date(start);
    while (cursor.getTime() <= end.getTime()) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + stepDays);
    }
    return dates;
  }

  return value
    .split(/[;,]/)
    .map((segment) => normalizeAttendancePreviewDate(segment))
    .filter((segment): segment is string => Boolean(segment));
}

function getImportRowField(row: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    if (row[key]) return row[key];
  }
  return "";
}

export default function Attendance() {
  const { user } = useUser();
  const { toast } = useToast();
  const [selectedEventId, setSelectedEventId] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [importBatch, setImportBatch] = useState<any | null>(null);
  const [importRows, setImportRows] = useState<any[]>([]);
  const [decisionMap, setDecisionMap] = useState<Record<string, "skip" | "update">>({});
  const [uploading, setUploading] = useState(false);
  const [submittingAll, setSubmittingAll] = useState(false);
  const [submittingRowMap, setSubmittingRowMap] = useState<Record<string, boolean>>({});
  const [committingImport, setCommittingImport] = useState(false);
  const [removingImport, setRemovingImport] = useState(false);
  const csvFileInputRef = useRef<HTMLInputElement | null>(null);
  const eventCommandListRef = useRef<HTMLDivElement | null>(null);
  const [eventPickerOpen, setEventPickerOpen] = useState(false);
  const [eventSearchTerm, setEventSearchTerm] = useState("");
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [archiveRow, setArchiveRow] = useState<AttendanceRow | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [highlightedAttendanceId, setHighlightedAttendanceId] = useState<string | null>(null);
  const [attendancePage, setAttendancePage] = useState(1);
  const [importTableMode, setImportTableMode] = useState<"matched" | "issues">("matched");
  const [matchedPage, setMatchedPage] = useState(1);
  const [issuesPage, setIssuesPage] = useState(1);
  const [manualForm, setManualForm] = useState({
    employeeId: "",
    attendanceDate: "",
    hoursCredited: "0",
    attendanceStatus: "present",
  });
  const searchParams = new URLSearchParams(window.location.search);
  const focusAttendanceId = searchParams.get("focusAttendanceId");
  const focusTrainingEventId = searchParams.get("trainingEventId");

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
  const normalizedEventSearchTerm = eventSearchTerm.trim().toLowerCase();
  const filteredActiveEvents = useMemo(() => {
    if (!normalizedEventSearchTerm) return activeEvents;

    return activeEvents.filter((event: any) =>
      String(event.title ?? "")
        .toLowerCase()
        .includes(normalizedEventSearchTerm),
    );
  }, [activeEvents, normalizedEventSearchTerm]);

  const { data: attendanceData, refetch: refetchAttendance, isLoading: attendanceLoading } = useQuery({
    queryKey: ["/api/attendance", selectedEventId],
    queryFn: async () => {
      if (!selectedEventId) return { attendance: [] };
      const res = await fetch(`/api/attendance?trainingEventId=${selectedEventId}`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Failed to load attendance.");
      return res.json();
    },
    enabled: !!selectedEventId,
  });

  const attendance = (attendanceData?.attendance ?? []) as AttendanceRow[];
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
    attendance.forEach((row) => {
      set.add(`${row.employeeId}:${row.attendanceDate}`);
    });
    return set;
  }, [attendance]);

  const committedImportEntryKeySet = useMemo(() => {
    const values = importBatch?.summaryJson?.committedEntryKeys;
    if (!Array.isArray(values)) return new Set<string>();
    return new Set(values.filter((value): value is string => typeof value === "string"));
  }, [importBatch]);

  const importPreviewRows = useMemo<AttendanceDisplayRow[]>(() => {
    if (!importBatch || !selectedEventId) return [];

    const rows: AttendanceDisplayRow[] = [];
    const seen = new Set<string>();

    importRows.forEach((row) => {
      if (row.matchStatus !== "matched" || !row.resolvedEmployeeId) return;

      const raw = (row.rawRowJson ?? {}) as Record<string, string>;
      const rawDateValue = getImportRowField(raw, [
        "Date",
        "attendance_date",
        "attendanceDate",
        "Attendance Date",
        "attendance date",
      ]);
      const parsedDates = parseAttendancePreviewDates(rawDateValue);
      const rawStatus =
        getImportRowField(raw, ["attendance_status", "attendanceStatus", "Status"]) || "present";
      const normalizedStatus = ["present", "absent", "partial"].includes(rawStatus.toLowerCase())
        ? rawStatus.toLowerCase()
        : "present";
      const shouldUpdateDuplicate = decisionMap[row.id] === "update";

      parsedDates.forEach((attendanceDate) => {
        const importEntryKey = `${row.id}::${attendanceDate}`;
        if (committedImportEntryKeySet.has(importEntryKey)) return;
        const key = `${row.resolvedEmployeeId}:${attendanceDate}`;
        const isDuplicate = duplicateKeySet.has(key);
        if (isDuplicate && !shouldUpdateDuplicate) return;
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({
          id: `import-preview:${row.id}:${attendanceDate}`,
          employeeId: row.resolvedEmployeeId,
          trainingEventId: selectedEventId,
          attendanceDate,
          attendanceStatus: normalizedStatus,
          workflowStatus: isDuplicate ? "import_duplicate" : "import_ready",
          source: "import_preview",
          importRowId: row.id,
        });
      });
    });

    return rows.sort((a, b) => {
      if (a.attendanceDate === b.attendanceDate) {
        return a.source.localeCompare(b.source);
        }
        return b.attendanceDate.localeCompare(a.attendanceDate);
      });
  }, [committedImportEntryKeySet, decisionMap, duplicateKeySet, importBatch, importRows, selectedEventId]);

  const filteredAttendance = useMemo<AttendanceDisplayRow[]>(() => {
    const combinedRows: AttendanceDisplayRow[] = [
      ...attendance.map((row) => ({ ...row, source: "record" as const })),
      ...importPreviewRows,
    ];

    return combinedRows
      .filter((row) => {
        const emp = employeeMap.get(row.employeeId);
        const haystack = `${emp?.fullName ?? ""} ${emp?.employeeNo ?? ""}`.toLowerCase();
        return haystack.includes(searchTerm.toLowerCase());
      })
      .sort((a, b) => {
        if (a.attendanceDate === b.attendanceDate) {
          return a.source.localeCompare(b.source);
        }
        return b.attendanceDate.localeCompare(a.attendanceDate);
      });
  }, [attendance, employeeMap, importPreviewRows, searchTerm]);
  const attendancePageCount = Math.max(1, Math.ceil(filteredAttendance.length / IMPORT_REVIEW_PAGE_SIZE));
  const visibleAttendanceRows = useMemo(
    () =>
      filteredAttendance.slice(
        (attendancePage - 1) * IMPORT_REVIEW_PAGE_SIZE,
        attendancePage * IMPORT_REVIEW_PAGE_SIZE,
      ),
    [attendancePage, filteredAttendance],
  );

  const submittableRows = useMemo(
    () => attendance.filter((row) => ["draft", "returned"].includes(row.workflowStatus)),
    [attendance],
  );
  const hasPendingEntriesForImportRow = useMemo(() => {
    return (row: any) => {
      if (row.matchStatus !== "matched" || !row.resolvedEmployeeId) return false;

      const raw = (row.rawRowJson ?? {}) as Record<string, string>;
      const rawDateValue = getImportRowField(raw, [
        "Date",
        "attendance_date",
        "attendanceDate",
        "Attendance Date",
        "attendance date",
      ]);
      const parsedDates = parseAttendancePreviewDates(rawDateValue);
      if (parsedDates.length === 0) return false;
      const shouldUpdateDuplicate = decisionMap[row.id] === "update";

      return parsedDates.some((attendanceDate) => {
        if (committedImportEntryKeySet.has(`${row.id}::${attendanceDate}`)) {
          return false;
        }

        const key = `${row.resolvedEmployeeId}:${attendanceDate}`;
        return !duplicateKeySet.has(key) || shouldUpdateDuplicate;
      });
    };
  }, [committedImportEntryKeySet, decisionMap, duplicateKeySet]);
  const hasPendingIssueEntriesForImportRow = useMemo(() => {
    return (row: any) => {
      if (row.matchStatus !== "matched" || !row.resolvedEmployeeId) return row.matchStatus !== "matched";

      const raw = (row.rawRowJson ?? {}) as Record<string, string>;
      const rawDateValue = getImportRowField(raw, [
        "Date",
        "attendance_date",
        "attendanceDate",
        "Attendance Date",
        "attendance date",
      ]);
      const parsedDates = parseAttendancePreviewDates(rawDateValue);
      if (parsedDates.length === 0) return false;
      const shouldUpdateDuplicate = decisionMap[row.id] === "update";

      return parsedDates.some((attendanceDate) => {
        if (committedImportEntryKeySet.has(`${row.id}::${attendanceDate}`)) {
          return false;
        }

        const key = `${row.resolvedEmployeeId}:${attendanceDate}`;
        return duplicateKeySet.has(key) && !shouldUpdateDuplicate;
      });
    };
  }, [committedImportEntryKeySet, decisionMap, duplicateKeySet]);
  const matchedImportRows = useMemo(
    () => importRows.filter((row) => hasPendingEntriesForImportRow(row)),
    [hasPendingEntriesForImportRow, importRows],
  );
  const issueImportRows = useMemo(
    () => importRows.filter((row) => hasPendingIssueEntriesForImportRow(row)),
    [hasPendingIssueEntriesForImportRow, importRows],
  );
  const hasPendingMatchedImportRows = matchedImportRows.length > 0;
  const matchedPageCount = Math.max(1, Math.ceil(matchedImportRows.length / IMPORT_REVIEW_PAGE_SIZE));
  const visibleMatchedRows = useMemo(
    () =>
      matchedImportRows.slice(
        (matchedPage - 1) * IMPORT_REVIEW_PAGE_SIZE,
        matchedPage * IMPORT_REVIEW_PAGE_SIZE,
      ),
    [matchedImportRows, matchedPage],
  );
  const issuePageCount = Math.max(1, Math.ceil(issueImportRows.length / IMPORT_REVIEW_PAGE_SIZE));
  const visibleIssueRows = useMemo(
    () =>
      issueImportRows.slice(
        (issuesPage - 1) * IMPORT_REVIEW_PAGE_SIZE,
        issuesPage * IMPORT_REVIEW_PAGE_SIZE,
      ),
    [issueImportRows, issuesPage],
  );
  const displayedImportRows = importTableMode === "matched" ? visibleMatchedRows : visibleIssueRows;
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
    setAttendancePage(1);
    setImportTableMode("matched");
    setMatchedPage(1);
    setIssuesPage(1);
  }, [selectedEventId]);

  useEffect(() => {
    setAttendancePage(1);
  }, [searchTerm]);

  useEffect(() => {
    if (attendancePage > attendancePageCount) {
      setAttendancePage(attendancePageCount);
    }
  }, [attendancePage, attendancePageCount]);

  useEffect(() => {
    if (matchedPage > matchedPageCount) {
      setMatchedPage(matchedPageCount);
    }
  }, [matchedPage, matchedPageCount]);

  useEffect(() => {
    if (issuesPage > issuePageCount) {
      setIssuesPage(issuePageCount);
    }
  }, [issuePageCount, issuesPage]);

  useEffect(() => {
    if (!selectedEvent) return;
    setManualForm((prev) => ({
      ...prev,
      hoursCredited: prev.hoursCredited === "0" ? String(selectedEvent.hours) : prev.hoursCredited,
    }));
  }, [selectedEvent?.id, selectedEvent?.hours]);

  useEffect(() => {
    if (importTableMode !== "matched") return;
    if (hasPendingMatchedImportRows) return;
    if (!importBatch) return;
    setImportTableMode("issues");
  }, [hasPendingMatchedImportRows, importBatch, importTableMode]);

  useEffect(() => {
    if (!eventPickerOpen) return;
    const frame = window.requestAnimationFrame(() => {
      eventCommandListRef.current?.scrollTo({ top: 0, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [eventPickerOpen, eventSearchTerm]);

  useEffect(() => {
    if (!focusTrainingEventId) return;
    if (!events.some((event: any) => event.id === focusTrainingEventId)) return;
    setSelectedEventId((current) => current || focusTrainingEventId);
  }, [events, focusTrainingEventId]);

  useEffect(() => {
    if (!focusAttendanceId) return;
    if (!filteredAttendance.some((row: AttendanceRow) => row.id === focusAttendanceId)) return;
    setHighlightedAttendanceId(focusAttendanceId);
    const timer = window.setTimeout(() => {
      setHighlightedAttendanceId((current) => (current === focusAttendanceId ? null : current));
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [focusAttendanceId, filteredAttendance]);

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
        const rawText = await res.text();
        let payload: any = null;
        try {
          payload = rawText ? JSON.parse(rawText) : null;
        } catch {
          payload = null;
        }

        if (res.status === 409 && payload?.batchId) {
          const existingRes = await fetch(`/api/attendance/import/${payload.batchId}`, {
            credentials: "include",
          });
          if (existingRes.ok) {
            const existingData = await existingRes.json();
            setImportBatch(existingData.batch);
            setImportRows(existingData.rows ?? []);
            setDecisionMap({});
            toast({
              title: "Existing CSV batch loaded",
              description: "This file was already uploaded. Review the issue rows and commit the matched rows when ready.",
            });
            return;
          }
          toast({
            title: "CSV already uploaded",
            description:
              "This file already exists for the selected event. Refresh the page to continue with the existing batch.",
          });
          return;
        }

        if (
          res.status === 409 &&
          typeof payload?.message === "string" &&
          payload.message.toLowerCase().includes("already uploaded")
        ) {
          toast({
            title: "CSV already uploaded",
            description: payload.message,
          });
          return;
        }

        throw new Error(typeof payload?.message === "string" ? payload.message : rawText || "Request failed.");
      }
      const data = await res.json();
      setImportBatch(data.batch);
      setImportRows(data.rows);
      setDecisionMap({});
      setImportTableMode("matched");
      setMatchedPage(1);
      setIssuesPage(1);
      toast({
        title: data.reusedExistingBatch ? "Existing CSV batch loaded" : "CSV uploaded",
        description: data.reusedExistingBatch
          ? "This file is already pending review. You can commit the matched rows now and leave the issue rows for review."
          : "Review matched rows and commit them when ready. Any issue rows will remain listed below.",
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

  const handleCommit = async () => {
    if (!canManageAttendance) return;
    if (!importBatch) return;
    if (committingImport) return;
    const decisions = Object.entries(decisionMap).map(([rowId, action]) => ({
      rowId,
      action,
    }));
    try {
      setCommittingImport(true);
      const res = await apiRequest("POST", `/api/attendance/import/${importBatch.id}/commit`, {
        decisions,
      });
      const data = await res.json();
      if (data.batch?.status === "committed") {
        setImportBatch(null);
        setImportRows([]);
      } else {
        setImportBatch(data.batch ?? importBatch);
        setImportRows(data.rows ?? importRows);
        setImportTableMode("issues");
        setMatchedPage(1);
        setIssuesPage(1);
      }
      setDecisionMap({});
      await refetchAttendance();
      toast({
        title:
          data.batch?.status === "committed"
            ? "Import committed successfully."
            : "Matched rows committed. Remaining issue rows are still listed for review.",
        description:
          data.results && typeof data.results === "object"
            ? `Created: ${data.results.created ?? 0} · Updated: ${data.results.updated ?? 0} · Skipped: ${data.results.skipped ?? 0}`
            : undefined,
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Failed to commit import",
        description: error instanceof Error ? error.message : "Unable to commit import batch.",
      });
    } finally {
      setCommittingImport(false);
    }
  };

  const handleRemoveLoadedFile = async () => {
    if (!canBulkImport) return;
    if (!importBatch) return;
    if (removingImport) return;

    try {
      setRemovingImport(true);
      await apiRequest("DELETE", `/api/attendance/import/${importBatch.id}`);
      setImportBatch(null);
      setImportRows([]);
      setDecisionMap({});
      setImportTableMode("matched");
      setMatchedPage(1);
      setIssuesPage(1);
      toast({
        title: "Loaded CSV removed",
        description: "The current pending import batch was removed.",
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Failed to remove loaded file",
        description: error instanceof Error ? error.message : "Unable to remove the current import batch.",
      });
    } finally {
      setRemovingImport(false);
    }
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
    if (submittingAll || submittingRowMap[attendanceId]) return;
    try {
      setSubmittingRowMap((prev) => ({ ...prev, [attendanceId]: true }));
      await apiRequest("POST", `/api/attendance/${attendanceId}/submit`);
      await queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
      await refetchAttendance();
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Failed to submit attendance",
        description: error instanceof Error ? error.message : "Unable to submit attendance record.",
      });
    } finally {
      setSubmittingRowMap((prev) => {
        const next = { ...prev };
        delete next[attendanceId];
        return next;
      });
    }
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
    if (submittableRows.length === 0 || submittingAll) return;
    try {
      setSubmittingAll(true);
      setSubmittingRowMap(
        submittableRows.reduce<Record<string, boolean>>((acc, row) => {
          acc[row.id] = true;
          return acc;
        }, {}),
      );
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
      setSubmittingRowMap({});
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
            <Popover
              open={eventPickerOpen}
              onOpenChange={(open) => {
                setEventPickerOpen(open);
                if (!open) {
                  setEventSearchTerm("");
                }
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  className="w-full justify-between gap-2 overflow-hidden font-normal"
                >
                  <span className="min-w-0 flex-1 truncate text-left">
                    {selectedEvent ? selectedEvent.title : "Select event..."}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder="Search training title..."
                    value={eventSearchTerm}
                    onValueChange={setEventSearchTerm}
                  />
                  <CommandList ref={eventCommandListRef} className="max-h-72">
                    <CommandEmpty>No matching training found.</CommandEmpty>
                    <CommandGroup>
                      {filteredActiveEvents.map((training: any) => (
                        <CommandItem
                          key={training.id}
                          value={training.title}
                          onSelect={() => {
                            setSelectedEventId(training.id);
                            setEventSearchTerm("");
                            setEventPickerOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              selectedEventId === training.id ? "opacity-100" : "opacity-0",
                            )}
                          />
                          {training.title}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

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
          <CardHeader className="flex flex-col gap-4">
            <div className="min-w-0">
              <CardTitle>Attendance Sheet</CardTitle>
              <CardDescription className="max-w-full break-words">
                {selectedEvent ? `Recording for: ${selectedEvent.title}` : "Select an event to start"}
              </CardDescription>
            </div>
            {selectedEvent && (
              <div className="flex w-full flex-wrap gap-2 sm:justify-end">
                {canSubmit && submittableRows.length > 0 ? (
                  <Button
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
                {canBulkImport && importBatch ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={handleRemoveLoadedFile}
                    disabled={removingImport || committingImport}
                  >
                    {removingImport ? (
                      <>
                        <Spinner className="mr-2 h-4 w-4" />
                        Removing...
                      </>
                    ) : (
                      "Remove Loaded File"
                    )}
                  </Button>
                ) : null}
                {canManageAttendance && importBatch && hasPendingMatchedImportRows ? (
                  <Button size="sm" onClick={handleCommit} disabled={committingImport || removingImport}>
                    {committingImport ? (
                      <>
                        <Spinner className="mr-2 h-4 w-4" />
                        Committing...
                      </>
                    ) : (
                      <>
                        <Save className="mr-2 h-4 w-4" />
                        {(importBatch.summaryJson?.unmatched ?? 0) > 0 ||
                        (importBatch.summaryJson?.invalid ?? 0) > 0
                          ? "Commit Matched"
                          : "Commit Import"}
                      </>
                    )}
                  </Button>
                ) : null}
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
                    . Date supports single date, comma-separated dates, or ranges using{" "}
                    <span className="font-medium">to</span> (e.g.,{" "}
                    <span className="font-medium">10/29/25 to 12/17/25</span>).
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
                      {visibleAttendanceRows.map((row) => {
                        const emp = employeeMap.get(row.employeeId);
                        const isImportPreview = row.source === "import_preview";
                        const duplicateDecision = row.importRowId ? decisionMap[row.importRowId] : undefined;
                        return (
                          <TableRow
                            key={row.id}
                            className={
                              highlightedAttendanceId === row.id ? "bg-primary/5 ring-1 ring-primary/40" : ""
                            }
                          >
                            <TableCell>
                              <div className="font-medium">{emp?.fullName ?? "Unknown"}</div>
                              <div className="text-xs text-muted-foreground">{emp?.employeeNo ?? "-"}</div>
                            </TableCell>
                            <TableCell>{row.attendanceDate}</TableCell>
                            <TableCell>
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge variant="outline">
                                  {isImportPreview
                                    ? row.workflowStatus === "import_duplicate"
                                      ? "import duplicate"
                                      : "import preview"
                                    : row.workflowStatus}
                                </Badge>
                                <span className="text-xs capitalize text-muted-foreground">
                                  {row.attendanceStatus}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {isImportPreview ? (
                                  <span className="text-xs text-muted-foreground">
                                    {row.workflowStatus === "import_duplicate"
                                      ? duplicateDecision === "update"
                                        ? "Updates existing record on commit"
                                        : "Choose Update below to overwrite existing"
                                      : "Ready to commit from the import batch"}
                                  </span>
                                ) : canSubmit && ["draft", "returned"].includes(row.workflowStatus) ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={submittingAll || submittingRowMap[row.id]}
                                    onClick={() => submitAttendance(row.id)}
                                  >
                                    {submittingRowMap[row.id] ? (
                                      <>
                                        <Spinner className="mr-2 h-4 w-4" />
                                        Submitting...
                                      </>
                                    ) : (
                                      "Submit"
                                    )}
                                  </Button>
                                ) : null}
                                {!isImportPreview && canManageAttendance ? (
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

                {filteredAttendance.length > IMPORT_REVIEW_PAGE_SIZE ? (
                  <div className="flex items-center justify-end gap-2">
                    <span className="mr-auto text-xs text-muted-foreground">
                      Showing {visibleAttendanceRows.length} of {filteredAttendance.length} attendance rows.
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={attendancePage === 1}
                      onClick={() => setAttendancePage((current) => Math.max(1, current - 1))}
                    >
                      Previous
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Page {attendancePage} of {attendancePageCount}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={attendancePage === attendancePageCount}
                      onClick={() => setAttendancePage((current) => Math.min(attendancePageCount, current + 1))}
                    >
                      Next
                    </Button>
                  </div>
                ) : null}

                {importBatch ? (
                  <div className="space-y-4">
                    <div className="rounded-md border border-border/70 p-4 text-sm">
                      <div className="font-medium">Import Summary</div>
                      <div className="text-muted-foreground">
                        Total: {importBatch.summaryJson?.total ?? importRows.length} · Matched: {importBatch.summaryJson?.matched ?? 0} · Unmatched: {importBatch.summaryJson?.unmatched ?? 0} · Invalid: {importBatch.summaryJson?.invalid ?? 0}
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        Commit matched rows now to turn them into draft attendance records you can submit above, even if issue rows still remain below.
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant={importTableMode === "matched" ? "default" : "outline"}
                        size="sm"
                        onClick={() => {
                          setImportTableMode("matched");
                          setMatchedPage(1);
                        }}
                      >
                        Matched Preview ({matchedImportRows.length})
                      </Button>
                      <Button
                        type="button"
                        variant={importTableMode === "issues" ? "default" : "outline"}
                        size="sm"
                        onClick={() => {
                          setImportTableMode("issues");
                          setIssuesPage(1);
                        }}
                      >
                        Issues ({issueImportRows.length})
                      </Button>
                      {importTableMode === "issues" ? (
                        <span className="text-xs text-muted-foreground">
                          Showing {visibleIssueRows.length} of {issueImportRows.length} issue rows per page to keep the page responsive.
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Showing {visibleMatchedRows.length} of {matchedImportRows.length} matched rows per page to keep the preview responsive.
                        </span>
                      )}
                    </div>

                    <div className="rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Email</TableHead>
                            <TableHead>Participants</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Reason</TableHead>
                            <TableHead>Duplicate</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {displayedImportRows.map((row) => {
                            const raw = row.rawRowJson || {};
                            const attendanceDate = getImportRowField(raw, [
                              "Date",
                              "attendance_date",
                              "attendanceDate",
                              "Attendance Date",
                              "attendance date",
                            ]);
                            const participants = getImportRowField(raw, ["Participants"]);
                            const email = getImportRowField(raw, ["Email", "email"]);
                            const parsedDates = parseAttendancePreviewDates(attendanceDate);
                            const isDuplicate =
                              !!row.resolvedEmployeeId &&
                              parsedDates.some((parsedDate) => {
                                const key = `${row.resolvedEmployeeId}:${parsedDate}`;
                                return (
                                  !committedImportEntryKeySet.has(`${row.id}::${parsedDate}`) &&
                                  duplicateKeySet.has(key)
                                );
                              });
                            const reason =
                              row.errorMessage ||
                              (isDuplicate
                                ? "Matches an existing attendance record. Choose Update to overwrite it, or leave it skipped."
                                : "-");
                            return (
                              <TableRow key={row.id}>
                                <TableCell>{email || "-"}</TableCell>
                                <TableCell>{participants || "-"}</TableCell>
                                <TableCell>{attendanceDate || "-"}</TableCell>
                                <TableCell>
                                  <Badge variant="outline">{row.matchStatus}</Badge>
                                </TableCell>
                                <TableCell className="max-w-[260px] text-xs text-muted-foreground">
                                  {reason}
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
                                    <span className="text-muted-foreground">-</span>
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>

                    {importTableMode === "matched" && matchedImportRows.length > IMPORT_REVIEW_PAGE_SIZE ? (
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={matchedPage === 1}
                          onClick={() => setMatchedPage((current) => Math.max(1, current - 1))}
                        >
                          Previous
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          Page {matchedPage} of {matchedPageCount}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={matchedPage === matchedPageCount}
                          onClick={() => setMatchedPage((current) => Math.min(matchedPageCount, current + 1))}
                        >
                          Next
                        </Button>
                      </div>
                    ) : null}

                    {importTableMode === "issues" && issueImportRows.length > IMPORT_REVIEW_PAGE_SIZE ? (
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={issuesPage === 1}
                          onClick={() => setIssuesPage((current) => Math.max(1, current - 1))}
                        >
                          Previous
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          Page {issuesPage} of {issuePageCount}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={issuesPage === issuePageCount}
                          onClick={() =>
                            setIssuesPage((current) => Math.min(issuePageCount, current + 1))
                          }
                        >
                          Next
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


