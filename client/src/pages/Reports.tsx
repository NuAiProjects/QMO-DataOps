import { useMemo, useState } from "react";
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
import { useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";

type ReportFilters = {
  from: string;
  to: string;
  unitId: string;
  includeChildren: boolean;
};

const buildQuery = (filters: ReportFilters) => {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.unitId) params.set("unitId", filters.unitId);
  if (filters.includeChildren) params.set("includeChildren", "true");
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
    includeChildren: true,
  });

  const query = useMemo(() => buildQuery(filters), [filters]);

  const { data: unitData } = useQuery({
    queryKey: ["/api/units"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const units = unitData?.units ?? [];

  const { data: hoursByEmployee } = useQuery({
    queryKey: ["/api/reports/hours-by-employee", query],
    queryFn: () => fetchReport("/api/reports/hours-by-employee", query),
  });
  const { data: hoursByUnit } = useQuery({
    queryKey: ["/api/reports/hours-by-unit", query],
    queryFn: () => fetchReport("/api/reports/hours-by-unit", query),
  });
  const { data: compliance } = useQuery({
    queryKey: ["/api/reports/compliance", query],
    queryFn: () => fetchReport("/api/reports/compliance", query),
  });

  const handleExport = (endpoint: string) => {
    const exportQuery = `${query}${query ? "&" : ""}format=csv`;
    window.open(`${endpoint}?${exportQuery}`, "_blank");
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-display font-bold">Reports & Analytics</h1>
        <p className="text-muted-foreground">Generate institutional reports and export data.</p>
      </div>

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle>Report Filters</CardTitle>
          <CardDescription>Apply filters to all reports below.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
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
          <div className="space-y-2">
            <label className="text-sm font-medium">Include Children</label>
            <Select
              value={filters.includeChildren ? "true" : "false"}
              onValueChange={(value) =>
                setFilters((prev) => ({ ...prev, includeChildren: value === "true" }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">Yes</SelectItem>
                <SelectItem value="false">No</SelectItem>
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
        </CardContent>
      </Card>

      <Card className="border-border/60">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Mandatory Compliance</CardTitle>
            <CardDescription>Completion status for mandatory trainings.</CardDescription>
          </div>
          <Button variant="outline" onClick={() => handleExport("/api/reports/compliance")}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Total Mandatory</TableHead>
                <TableHead>Compliance %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(compliance?.rows ?? []).map((row: any) => (
                <TableRow key={row.employeeId}>
                  <TableCell>{row.fullName}</TableCell>
                  <TableCell>{row.completedMandatory}</TableCell>
                  <TableCell>{row.totalMandatory}</TableCell>
                  <TableCell>{row.compliancePercent}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
