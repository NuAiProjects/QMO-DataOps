import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Download } from "lucide-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";

type ReportFilters = {
  from: string;
  to: string;
  unitId: string;
};

type ReportPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type ReportResponse<T> = {
  rows: T[];
  pagination?: ReportPagination;
};

const buildQuery = (filters: ReportFilters) => {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.unitId) {
    params.set("unitId", filters.unitId);
    params.set("includeChildren", "true");
  }
  return params.toString();
};

const withPage = (query: string, page: number) => {
  const params = new URLSearchParams(query);
  params.set("page", String(page));
  return params.toString();
};

async function fetchReport(endpoint: string, query: string) {
  const res = await fetch(`${endpoint}?${query}`, { credentials: "include" });
  if (!res.ok) {
    throw new Error("Failed to load report.");
  }
  return res.json();
}

export default function Reports() {
  const [filters, setFilters] = useState<ReportFilters>({
    from: "",
    to: "",
    unitId: "",
  });
  const [employeePage, setEmployeePage] = useState(1);
  const [unitPage, setUnitPage] = useState(1);

  const baseQuery = useMemo(() => buildQuery(filters), [filters]);
  const employeeQuery = useMemo(() => withPage(baseQuery, employeePage), [baseQuery, employeePage]);
  const unitQuery = useMemo(() => withPage(baseQuery, unitPage), [baseQuery, unitPage]);

  useEffect(() => {
    setEmployeePage(1);
    setUnitPage(1);
  }, [baseQuery]);

  const { data: unitData, isLoading: unitsLoading } = useQuery({
    queryKey: ["/api/units"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const units = unitData?.units ?? [];

  const {
    data: hoursByEmployee,
    isLoading: hoursByEmployeeLoading,
    isFetching: hoursByEmployeeFetching,
  } = useQuery<ReportResponse<any>>({
    queryKey: ["/api/reports/hours-by-employee", employeeQuery],
    queryFn: () => fetchReport("/api/reports/hours-by-employee", employeeQuery),
    placeholderData: keepPreviousData,
  });
  const {
    data: hoursByUnit,
    isLoading: hoursByUnitLoading,
    isFetching: hoursByUnitFetching,
  } = useQuery<ReportResponse<any>>({
    queryKey: ["/api/reports/hours-by-unit", unitQuery],
    queryFn: () => fetchReport("/api/reports/hours-by-unit", unitQuery),
    placeholderData: keepPreviousData,
  });
  const handleExport = (endpoint: string) => {
    const exportQuery = `${baseQuery}${baseQuery ? "&" : ""}format=csv`;
    window.open(`${endpoint}?${exportQuery}`, "_blank");
  };

  const getPaginationLabel = (data?: ReportResponse<any>) => {
    const pagination = data?.pagination;
    if (!pagination || pagination.total === 0) {
      return "Showing 0 of 0";
    }
    const start = (pagination.page - 1) * pagination.pageSize + 1;
    const end = start + (data?.rows.length ?? 0) - 1;
    return `Showing ${start}-${end} of ${pagination.total}`;
  };

  const isPageLoading =
    unitsLoading ||
    (!hoursByEmployee && hoursByEmployeeLoading) ||
    (!hoursByUnit && hoursByUnitLoading);
  const isRefreshing = hoursByEmployeeFetching || hoursByUnitFetching;

  if (isPageLoading) {
    return <LoadingState label="Loading reports..." className="min-h-[520px]" />;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-display font-bold">Reports & Analytics</h1>
        {isRefreshing ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Refreshing...
          </div>
        ) : null}
      </div>
      <p className="text-muted-foreground">Generate institutional reports and export data.</p>

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle>Report Filters</CardTitle>
          <CardDescription>Apply filters to all reports below.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <label className="text-sm font-medium">From</label>
            <Input
              type="date"
              value={filters.from}
              onChange={(e) => setFilters((prev) => ({ ...prev, from: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">To</label>
            <Input
              type="date"
              value={filters.to}
              onChange={(e) => setFilters((prev) => ({ ...prev, to: e.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Unit Scope</label>
            <Select
              value={filters.unitId || "all"}
              onValueChange={(value) =>
                setFilters((prev) => ({ ...prev, unitId: value === "all" ? "" : value }))
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="All units" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Units</SelectItem>
                {units.map((unit: any) => (
                  <SelectItem key={unit.id} value={unit.id}>
                    {unit.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Hours by Employee</CardTitle>
            <CardDescription>Total training hours credited per employee.</CardDescription>
          </div>
          <Button variant="outline" onClick={() => handleExport("/api/reports/hours-by-employee")}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee No</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Total Hours</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(hoursByEmployee?.rows ?? []).map((row: any) => (
                <TableRow key={row.employeeId}>
                  <TableCell>{row.employeeNo}</TableCell>
                  <TableCell>{row.fullName}</TableCell>
                  <TableCell>{row.totalHours}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>{getPaginationLabel(hoursByEmployee)}</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEmployeePage((prev) => Math.max(1, prev - 1))}
                disabled={(hoursByEmployee?.pagination?.page ?? employeePage) <= 1}
              >
                Previous
              </Button>
              <span>
                Page {hoursByEmployee?.pagination?.page ?? employeePage} of{" "}
                {hoursByEmployee?.pagination?.totalPages ?? 1}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEmployeePage((prev) => prev + 1)}
                disabled={
                  (hoursByEmployee?.pagination?.page ?? employeePage) >=
                  (hoursByEmployee?.pagination?.totalPages ?? 1)
                }
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Hours by Unit</CardTitle>
            <CardDescription>Aggregated training hours by unit and department.</CardDescription>
          </div>
          <Button variant="outline" onClick={() => handleExport("/api/reports/hours-by-unit")}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Unit</TableHead>
                <TableHead>Total Hours</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(hoursByUnit?.rows ?? []).map((row: any) => (
                <TableRow key={row.unitId}>
                  <TableCell>{row.unitName}</TableCell>
                  <TableCell>{row.totalHours}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>{getPaginationLabel(hoursByUnit)}</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setUnitPage((prev) => Math.max(1, prev - 1))}
                disabled={(hoursByUnit?.pagination?.page ?? unitPage) <= 1}
              >
                Previous
              </Button>
              <span>
                Page {hoursByUnit?.pagination?.page ?? unitPage} of{" "}
                {hoursByUnit?.pagination?.totalPages ?? 1}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setUnitPage((prev) => prev + 1)}
                disabled={
                  (hoursByUnit?.pagination?.page ?? unitPage) >=
                  (hoursByUnit?.pagination?.totalPages ?? 1)
                }
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
