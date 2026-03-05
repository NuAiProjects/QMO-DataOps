import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useUser } from "@/hooks/use-user";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, getQueryFn, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  MoreHorizontal,
  Filter,
  Download,
  Upload,
  UserPlus,
} from "lucide-react";

type EmployeeStatus = "active" | "inactive";

type Employee = {
  id: string;
  fullName: string;
  email: string | null;
  unitId: string;
  position: string | null;
  employmentStatus: EmployeeStatus;
};

type Unit = {
  id: string;
  name: string;
};

type TrainingEvent = {
  id: string;
  title: string;
};

type AttendanceRecord = {
  id: string;
  trainingEventId: string;
  attendanceDate: string;
  hoursCredited: string;
  attendanceStatus: "present" | "absent" | "partial";
  workflowStatus: "draft" | "submitted" | "returned" | "approved" | "locked";
};

type EmployeesResponse = {
  employees: Employee[];
};

type UnitsResponse = {
  units: Unit[];
};

type TrainingsResponse = {
  trainingEvents: TrainingEvent[];
};

type AttendanceResponse = {
  attendance: AttendanceRecord[];
};

type EmployeeForm = {
  fullName: string;
  email: string;
  unitId: string;
  position: string;
  employmentStatus: EmployeeStatus;
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || "Request failed.");
  }
  return res.json();
}

function getErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : "Request failed.";
  return raw.replace(/^Error:\s*/, "");
}

function toNullableString(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function csvEscape(value: string | null | undefined) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const EMPLOYEE_PAGE_SIZE = 50;

export default function Employees() {
  const { user } = useUser();
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | EmployeeStatus>("all");
  const [unitFilter, setUnitFilter] = useState<string>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isProfileDialogOpen, setIsProfileDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isBulkUploading, setIsBulkUploading] = useState(false);
  const [isArchiveDialogOpen, setIsArchiveDialogOpen] = useState(false);
  const [archiveReason, setArchiveReason] = useState("");
  const employeeCsvInputRef = useRef<HTMLInputElement | null>(null);

  const [createForm, setCreateForm] = useState<EmployeeForm>({
    fullName: "",
    email: "",
    unitId: "",
    position: "",
    employmentStatus: "active",
  });
  const [editForm, setEditForm] = useState<EmployeeForm>({
    fullName: "",
    email: "",
    unitId: "",
    position: "",
    employmentStatus: "active",
  });

  const { data: employeeData, isLoading: employeesLoading } = useQuery<EmployeesResponse>({
    queryKey: ["/api/employees"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: unitData, isLoading: unitsLoading } = useQuery<UnitsResponse>({
    queryKey: ["/api/units"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: trainingData, isLoading: trainingsLoading } = useQuery<TrainingsResponse>({
    queryKey: ["/api/training-events"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const selectedEmployeeId = selectedEmployee?.id ?? "";
  const { data: historyData, isLoading: historyLoading } = useQuery<AttendanceResponse>({
    queryKey: ["/api/attendance", "employee", selectedEmployeeId],
    queryFn: () => fetchJson<AttendanceResponse>(`/api/attendance?employeeId=${selectedEmployeeId}`),
    enabled: isProfileDialogOpen && selectedEmployeeId.length > 0,
  });

  const employees = employeeData?.employees ?? [];
  const units = unitData?.units ?? [];
  const trainingEvents = trainingData?.trainingEvents ?? [];
  const historyRows = historyData?.attendance ?? [];

  const canEdit =
    user?.role === "super_admin" ||
    user?.role === "hr_qa_approver" ||
    user?.role === "unit_head" ||
    user?.role === "encoder";

  const unitMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const unit of units) {
      map.set(unit.id, unit.name);
    }
    return map;
  }, [units]);

  const trainingTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const event of trainingEvents) {
      map.set(event.id, event.title);
    }
    return map;
  }, [trainingEvents]);

  const filteredEmployees = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    return employees.filter((employee) => {
      if (statusFilter !== "all" && employee.employmentStatus !== statusFilter) {
        return false;
      }
      if (unitFilter !== "all" && employee.unitId !== unitFilter) {
        return false;
      }
      if (!q) {
        return true;
      }
      const haystack = [
        employee.fullName,
        employee.email || "",
        employee.position || "",
        unitMap.get(employee.unitId) || "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [employees, searchTerm, statusFilter, unitFilter, unitMap]);

  const totalPages = Math.max(1, Math.ceil(filteredEmployees.length / EMPLOYEE_PAGE_SIZE));
  const pageStartIndex = (currentPage - 1) * EMPLOYEE_PAGE_SIZE;
  const paginatedEmployees = useMemo(() => {
    return filteredEmployees.slice(pageStartIndex, pageStartIndex + EMPLOYEE_PAGE_SIZE);
  }, [filteredEmployees, pageStartIndex]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, unitFilter]);

  useEffect(() => {
    setCurrentPage((prev) => Math.min(prev, totalPages));
  }, [totalPages]);

  const historyRowsWithTitle = useMemo(() => {
    return [...historyRows].sort((a, b) => b.attendanceDate.localeCompare(a.attendanceDate));
  }, [historyRows]);

  const pageStartLabel = filteredEmployees.length === 0 ? 0 : pageStartIndex + 1;
  const pageEndLabel =
    filteredEmployees.length === 0
      ? 0
      : Math.min(pageStartIndex + paginatedEmployees.length, filteredEmployees.length);
  const isPageLoading = employeesLoading || unitsLoading || trainingsLoading;

  const hasActiveFilters = statusFilter !== "all" || unitFilter !== "all";

  const resetCreateForm = () => {
    setCreateForm({
      fullName: "",
      email: "",
      unitId: "",
      position: "",
      employmentStatus: "active",
    });
  };

  const handleCreate = async () => {
    if (!createForm.fullName.trim() || !createForm.email.trim()) {
      toast({
        variant: "destructive",
        title: "Full Name and Email are required.",
      });
      return;
    }
    const unitId = createForm.unitId || units[0]?.id;
    if (!unitId) {
      toast({
        variant: "destructive",
        title: "Select a department before saving.",
      });
      return;
    }

    try {
      await apiRequest("POST", "/api/employees", {
        fullName: createForm.fullName.trim(),
        email: createForm.email.trim().toLowerCase(),
        unitId,
        position: toNullableString(createForm.position),
        employmentStatus: createForm.employmentStatus,
      });

      await queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      setIsCreateDialogOpen(false);
      resetCreateForm();
      toast({ title: "Employee created successfully." });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Failed to create employee",
        description: getErrorMessage(error),
      });
    }
  };

  const openProfileDialog = (employee: Employee) => {
    setSelectedEmployee(employee);
    setIsProfileDialogOpen(true);
  };

  const openEditDialog = (employee: Employee) => {
    setSelectedEmployee(employee);
    setEditForm({
      fullName: employee.fullName,
      email: employee.email || "",
      unitId: employee.unitId,
      position: employee.position || "",
      employmentStatus: employee.employmentStatus,
    });
    setIsEditDialogOpen(true);
  };

  const handleEditSave = async () => {
    if (!selectedEmployee) return;
    if (!editForm.fullName.trim() || !editForm.email.trim()) {
      toast({
        variant: "destructive",
        title: "Full Name and Email are required.",
      });
      return;
    }
    const unitId = editForm.unitId || units[0]?.id;
    if (!unitId) {
      toast({
        variant: "destructive",
        title: "Select a department before saving.",
      });
      return;
    }

    try {
      await apiRequest("PUT", `/api/employees/${selectedEmployee.id}`, {
        fullName: editForm.fullName.trim(),
        email: editForm.email.trim().toLowerCase(),
        unitId,
        position: toNullableString(editForm.position),
        employmentStatus: editForm.employmentStatus,
      });

      await queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      setIsEditDialogOpen(false);
      toast({ title: "Employee updated successfully." });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Failed to update employee",
        description: getErrorMessage(error),
      });
    }
  };

  const handleToggleEmployeeStatus = async (employee: Employee) => {
    if (!canEdit) return;
    const nextStatus: EmployeeStatus =
      employee.employmentStatus === "active" ? "inactive" : "active";

    try {
      await apiRequest("PUT", `/api/employees/${employee.id}`, {
        employmentStatus: nextStatus,
      });

      await queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      toast({
        title:
          nextStatus === "inactive"
            ? "Employee deactivated."
            : "Employee reactivated.",
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Status update failed",
        description: getErrorMessage(error),
      });
    }
  };

  const handleArchiveEmployee = async () => {
    if (!selectedEmployee) return;
    try {
      await apiRequest("DELETE", `/api/employees/${selectedEmployee.id}`, {
        reason: archiveReason.trim(),
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      setIsArchiveDialogOpen(false);
      setIsProfileDialogOpen(false);
      setArchiveReason("");
      setSelectedEmployee(null);
      toast({ title: "Employee archived successfully." });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Failed to archive employee",
        description: getErrorMessage(error),
      });
    }
  };

  const handleExportCsv = () => {
    if (filteredEmployees.length === 0) {
      toast({
        variant: "destructive",
        title: "No employee records to export.",
      });
      return;
    }

    const headers = [
      "No.",
      "NU Email",
      "Full Name (Last Name, First Name Middle Name)",
      "ASP/Official/Faculty",
      "Department/College",
      "Division",
    ];

    const rows = filteredEmployees.map((employee, index) =>
      [
        String(index + 1),
        employee.email || "",
        employee.fullName,
        employee.position || "",
        unitMap.get(employee.unitId) || "",
        "",
      ]
        .map(csvEscape)
        .join(","),
    );

    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dateStamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `employees-${dateStamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleBulkUpload = async (file: File) => {
    try {
      setIsBulkUploading(true);
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/employees/import", {
        method: "POST",
        body: form,
        credentials: "include",
      });

      const responseText = await res.text();
      let parsedBody: unknown = null;
      if (responseText) {
        try {
          parsedBody = JSON.parse(responseText);
        } catch {
          parsedBody = null;
        }
      }

      if (!res.ok) {
        if (
          parsedBody &&
          typeof parsedBody === "object" &&
          "message" in parsedBody &&
          typeof (parsedBody as { message?: unknown }).message === "string"
        ) {
          throw new Error((parsedBody as { message: string }).message);
        }
        throw new Error(responseText || `Request failed (${res.status}).`);
      }

      if (!parsedBody || typeof parsedBody !== "object") {
        throw new Error(
          "Server returned a non-JSON response. Restart backend with `npm run dev` and try again.",
        );
      }

      const data = parsedBody as {
        summary?: { created?: number; updated?: number; invalid?: number; total?: number };
        errors?: Array<{ message?: string }>;
      };

      await queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      const created = data.summary?.created ?? 0;
      const updated = data.summary?.updated ?? 0;
      const invalid = data.summary?.invalid ?? 0;
      const hasErrors = Array.isArray(data.errors) && data.errors.length > 0;

      toast({
        title: "Employee import complete",
        description: `Created: ${created}, Updated: ${updated}, Invalid: ${invalid}${hasErrors ? ". Check CSV rows for invalid values." : "."}`,
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Employee import failed",
        description: getErrorMessage(error),
      });
    } finally {
      setIsBulkUploading(false);
    }
  };

  if (isPageLoading) {
    return <LoadingState label="Loading employee records..." className="min-h-[420px]" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold">Employee Directory</h1>
          <p className="text-muted-foreground">
            Manage academic and non-academic personnel records.
          </p>
        </div>

        {canEdit ? (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => employeeCsvInputRef.current?.click()}
              disabled={isBulkUploading}
            >
              {isBulkUploading ? (
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
              ref={employeeCsvInputRef}
              type="file"
              className="hidden"
              accept=".csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  handleBulkUpload(file);
                }
                e.currentTarget.value = "";
              }}
            />
            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button className="shadow-md">
                  <UserPlus className="mr-2 h-4 w-4" />
                  Add Employee
                </Button>
              </DialogTrigger>
              <DialogContent>
              <DialogHeader>
                <DialogTitle>New Employee</DialogTitle>
                <DialogDescription>
                  Create a new employee record for your department.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <Input
                  placeholder="Full Name"
                  value={createForm.fullName}
                  onChange={(e) =>
                    setCreateForm((prev) => ({ ...prev, fullName: e.target.value }))
                  }
                />
                <Input
                  placeholder="Email"
                  value={createForm.email}
                  onChange={(e) =>
                    setCreateForm((prev) => ({ ...prev, email: e.target.value }))
                  }
                />
                <Input
                  placeholder="Position (optional)"
                  value={createForm.position}
                  onChange={(e) =>
                    setCreateForm((prev) => ({ ...prev, position: e.target.value }))
                  }
                />
                <Select
                  value={createForm.unitId}
                  onValueChange={(value) =>
                    setCreateForm((prev) => ({ ...prev, unitId: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select department" />
                  </SelectTrigger>
                  <SelectContent>
                    {units.map((unit) => (
                      <SelectItem key={unit.id} value={unit.id}>
                        {unit.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={createForm.employmentStatus}
                  onValueChange={(value: EmployeeStatus) =>
                    setCreateForm((prev) => ({ ...prev, employmentStatus: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
                <Button onClick={handleCreate}>Create Employee</Button>
              </div>
              </DialogContent>
            </Dialog>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, or department..."
            className="pl-9"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className={hasActiveFilters ? "border-primary text-primary" : ""}>
              <Filter className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel>Filter Employees</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wide">
              Status
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as "all" | EmployeeStatus)}
            >
              <DropdownMenuRadioItem value="all">All Statuses</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="active">Active</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="inactive">Inactive</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wide">
              Department
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup value={unitFilter} onValueChange={setUnitFilter}>
              <DropdownMenuRadioItem value="all">All Departments</DropdownMenuRadioItem>
              {units.map((unit) => (
                <DropdownMenuRadioItem key={unit.id} value={unit.id}>
                  {unit.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setStatusFilter("all");
                setUnitFilter("all");
              }}
            >
              Reset Filters
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="outline" size="icon" onClick={handleExportCsv}>
          <Download className="h-4 w-4" />
        </Button>
      </div>

      {canEdit ? (
      <p className="text-xs text-muted-foreground">
          Bulk upload CSV required columns:{" "}
          <span className="font-medium">
            No., NU Email, Full Name (Last Name, First Name Middle Name), ASP/Official/Faculty, Department/College, Division
          </span>
          .
      </p>
      ) : null}

      <div className="rounded-md border border-border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead>Name</TableHead>
              <TableHead>Department</TableHead>
              <TableHead>Position/Division</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredEmployees.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  No employee records found.
                </TableCell>
              </TableRow>
            ) : (
              paginatedEmployees.map((employee) => (
                <TableRow key={employee.id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{employee.fullName}</span>
                      <span className="text-xs text-muted-foreground">{employee.email || "-"}</span>
                    </div>
                  </TableCell>
                  <TableCell>{unitMap.get(employee.unitId) || "-"}</TableCell>
                  <TableCell>{employee.position || "-"}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        employee.employmentStatus === "active"
                          ? "bg-emerald-500/15 text-emerald-700 border-emerald-200"
                          : "bg-amber-500/15 text-amber-700 border-amber-200"
                      }
                    >
                      {employee.employmentStatus === "active" ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" className="h-8 w-8 p-0">
                          <span className="sr-only">Open menu</span>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        <DropdownMenuItem onSelect={() => openProfileDialog(employee)}>
                          View Profile
                        </DropdownMenuItem>
                        {canEdit ? (
                          <>
                            <DropdownMenuItem onSelect={() => openEditDialog(employee)}>
                              Edit Details
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onSelect={() => handleToggleEmployeeStatus(employee)}
                            >
                              {employee.employmentStatus === "active" ? "Deactivate" : "Activate"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive"
                              onSelect={() => {
                                setSelectedEmployee(employee);
                                setArchiveReason("");
                                setIsArchiveDialogOpen(true);
                              }}
                            >
                              Archive (Soft Delete)
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        <div className="flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-sm text-muted-foreground">
            Showing {pageStartLabel}-{pageEndLabel} of {filteredEmployees.length} employees
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
              disabled={currentPage <= 1}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {currentPage} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
              disabled={currentPage >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      </div>

      <Dialog open={isProfileDialogOpen} onOpenChange={setIsProfileDialogOpen}>
        <DialogContent className="max-w-6xl w-[95vw] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Employee Profile</DialogTitle>
            <DialogDescription>
              Full profile details and training history.
            </DialogDescription>
          </DialogHeader>
          {selectedEmployee ? (
            <div className="space-y-6">
              <div className="rounded-md border p-4 space-y-4">
                <h3 className="text-base font-semibold">Profile Details</h3>
                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Full Name</p>
                    <p className="font-medium">{selectedEmployee.fullName}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Email</p>
                    <p>{selectedEmployee.email || "-"}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Department</p>
                    <p>{unitMap.get(selectedEmployee.unitId) || "-"}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Position</p>
                    <p>{selectedEmployee.position || "-"}</p>
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Employment Status</p>
                    <p className="font-medium">
                      {selectedEmployee.employmentStatus === "active" ? "Active" : "Inactive"}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-md border p-4 space-y-4">
                <h3 className="text-base font-semibold">Training History</h3>
                {historyLoading ? (
                  <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                    <Spinner className="h-4 w-4" />
                    Loading history...
                  </div>
                ) : historyRowsWithTitle.length === 0 ? (
                  <div className="py-6 text-sm text-muted-foreground">No training history available.</div>
                ) : (
                  <div className="rounded-md border max-h-[380px] overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Training</TableHead>
                          <TableHead>Hours</TableHead>
                          <TableHead>Attendance</TableHead>
                          <TableHead>Workflow</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {historyRowsWithTitle.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell>{row.attendanceDate}</TableCell>
                            <TableCell>
                              {trainingTitleMap.get(row.trainingEventId) || "Unknown Event"}
                            </TableCell>
                            <TableCell>{row.hoursCredited}</TableCell>
                            <TableCell className="capitalize">{row.attendanceStatus}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="capitalize">
                                {row.workflowStatus}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={isArchiveDialogOpen} onOpenChange={setIsArchiveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive Employee</DialogTitle>
            <DialogDescription>
              Provide a reason for archiving {selectedEmployee?.fullName || "this employee"}.
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
              onClick={handleArchiveEmployee}
            >
              Archive Employee
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-6xl w-[95vw] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Employee</DialogTitle>
            <DialogDescription>
              Update full employee profile details and save changes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Full Name</label>
                <Input
                  placeholder="Full Name"
                  value={editForm.fullName}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, fullName: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Email</label>
                <Input
                  placeholder="Email"
                  value={editForm.email}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, email: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Department</label>
                <Select
                  value={editForm.unitId}
                  onValueChange={(value) =>
                    setEditForm((prev) => ({ ...prev, unitId: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select department" />
                  </SelectTrigger>
                  <SelectContent>
                    {units.map((unit) => (
                      <SelectItem key={unit.id} value={unit.id}>
                        {unit.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Position</label>
                <Input
                  placeholder="Position (optional)"
                  value={editForm.position}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, position: e.target.value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Employment Status</label>
                <Select
                  value={editForm.employmentStatus}
                  onValueChange={(value: EmployeeStatus) =>
                    setEditForm((prev) => ({ ...prev, employmentStatus: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end border-t pt-4">
              <Button onClick={handleEditSave}>Save Changes</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
