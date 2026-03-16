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
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  BarChart3,
  Clock3,
  Download,
  GraduationCap,
  ShieldCheck,
  Users2,
} from "lucide-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";

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

type HoursByEmployeeRow = {
  employeeId: string;
  employeeNo: string;
  fullName: string;
  totalHours: number;
};

type HoursByUnitRow = {
  unitId: string;
  unitName: string;
  totalHours: number;
};

type TrainingAnalyticsResponse = {
  summary: {
    totalTrainings: number;
    approvedTrainings: number;
    mandatoryTrainings: number;
    optionalTrainings: number;
    participantRecords: number;
    uniqueParticipants: number;
    totalCreditedHours: number;
    averageParticipantsPerTraining: number;
    averageHoursPerTraining: number;
    approvalRate: number;
    mandatoryShare: number;
    dominantDeliveryMode: string | null;
  };
  deliveryModes: Array<{
    deliveryMode: string;
    label: string;
    count: number;
    sharePercent: number;
  }>;
  topTrainings: Array<{
    trainingEventId: string;
    title: string;
    shortTitle: string;
    deliveryModeLabel: string;
    ownerUnitName: string;
    participants: number;
    totalHoursCredited: number;
    plannedHours: number;
  }>;
  ownerUnits: Array<{
    unitId: string;
    unitName: string;
    trainingCount: number;
    participants: number;
    totalHoursCredited: number;
  }>;
  insights: string[];
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

async function fetchReport<T>(endpoint: string, query: string) {
  const url = query ? `${endpoint}?${query}` : endpoint;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error("Failed to load report.");
  }
  return (await res.json()) as T;
}

const deliveryChartConfig = {
  value: {
    label: "Trainings",
    color: "hsl(var(--chart-1))",
  },
  in_person: {
    label: "In Person",
    color: "hsl(var(--chart-1))",
  },
  virtual: {
    label: "Virtual",
    color: "hsl(var(--chart-2))",
  },
  hybrid: {
    label: "Hybrid",
    color: "hsl(var(--chart-3))",
  },
  self_paced: {
    label: "Self Paced",
    color: "hsl(var(--chart-4))",
  },
} satisfies ChartConfig;

const trainingReachChartConfig = {
  participants: {
    label: "Participants",
    color: "hsl(var(--chart-2))",
  },
} satisfies ChartConfig;

const ownerHoursChartConfig = {
  totalHoursCredited: {
    label: "Credited Hours",
    color: "hsl(var(--chart-5))",
  },
} satisfies ChartConfig;

const pieColors = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
];

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDecimal(value: number, digits = 1) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function truncateLabel(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function escapeCsvValue(value: unknown) {
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function rowsToCsv(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return "message\nNo data";
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escapeCsvValue(row[header])).join(",")),
  ];
  return lines.join("\n");
}

function buildSectionedCsv(
  sections: Array<{ title: string; rows: Array<Record<string, unknown>> }>,
) {
  return sections.map((section) => `${section.title}\n${rowsToCsv(section.rows)}`).join("\n\n");
}

function downloadCsvFile(fileName: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

function buildTrainingAnalyticsExportCsv(data: TrainingAnalyticsResponse) {
  return buildSectionedCsv([
    {
      title: "Summary",
      rows: [
        { metric: "Total Trainings", value: data.summary.totalTrainings },
        { metric: "Approved Trainings", value: data.summary.approvedTrainings },
        { metric: "Mandatory Trainings", value: data.summary.mandatoryTrainings },
        { metric: "Optional Trainings", value: data.summary.optionalTrainings },
        { metric: "Participant Records", value: data.summary.participantRecords },
        { metric: "Unique Participants", value: data.summary.uniqueParticipants },
        { metric: "Total Credited Hours", value: data.summary.totalCreditedHours },
        {
          metric: "Average Participants Per Training",
          value: data.summary.averageParticipantsPerTraining,
        },
        { metric: "Average Hours Per Training", value: data.summary.averageHoursPerTraining },
        { metric: "Approval Rate Percent", value: data.summary.approvalRate },
        { metric: "Mandatory Share Percent", value: data.summary.mandatoryShare },
        {
          metric: "Dominant Delivery Mode",
          value: data.summary.dominantDeliveryMode || "None",
        },
      ],
    },
    {
      title: "Delivery Modes",
      rows: data.deliveryModes.map((row) => ({
        deliveryMode: row.deliveryMode,
        label: row.label,
        trainings: row.count,
        sharePercent: row.sharePercent,
      })),
    },
    {
      title: "Highest Participation Trainings",
      rows: data.topTrainings.map((row) => ({
        trainingEventId: row.trainingEventId,
        title: row.title,
        deliveryMode: row.deliveryModeLabel,
        ownerUnitName: row.ownerUnitName,
        participants: row.participants,
        totalHoursCredited: row.totalHoursCredited,
        plannedHours: row.plannedHours,
      })),
    },
    {
      title: "Training Hours by Owning Unit",
      rows: data.ownerUnits.map((row) => ({
        unitId: row.unitId,
        unitName: row.unitName,
        trainingCount: row.trainingCount,
        participants: row.participants,
        totalHoursCredited: row.totalHoursCredited,
      })),
    },
    {
      title: "Training Insights",
      rows: data.insights.map((insight, index) => ({
        order: index + 1,
        insight,
      })),
    },
  ]);
}

function EmptyChartState({ label }: { label: string }) {
  return (
    <div className="flex h-[260px] items-center justify-center rounded-md border border-dashed bg-muted/20 px-4 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
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
    data: analytics,
    isLoading: analyticsLoading,
    isFetching: analyticsFetching,
  } = useQuery<TrainingAnalyticsResponse>({
    queryKey: ["/api/reports/training-analytics", baseQuery],
    queryFn: () => fetchReport<TrainingAnalyticsResponse>("/api/reports/training-analytics", baseQuery),
  });
  const {
    data: hoursByEmployee,
    isLoading: hoursByEmployeeLoading,
    isFetching: hoursByEmployeeFetching,
  } = useQuery<ReportResponse<HoursByEmployeeRow>>({
    queryKey: ["/api/reports/hours-by-employee", employeeQuery],
    queryFn: () => fetchReport<ReportResponse<HoursByEmployeeRow>>("/api/reports/hours-by-employee", employeeQuery),
    placeholderData: keepPreviousData,
  });
  const {
    data: hoursByUnit,
    isLoading: hoursByUnitLoading,
    isFetching: hoursByUnitFetching,
  } = useQuery<ReportResponse<HoursByUnitRow>>({
    queryKey: ["/api/reports/hours-by-unit", unitQuery],
    queryFn: () => fetchReport<ReportResponse<HoursByUnitRow>>("/api/reports/hours-by-unit", unitQuery),
    placeholderData: keepPreviousData,
  });

  const deliveryModeData = analytics?.deliveryModes ?? [];
  const topTrainingData = analytics?.topTrainings ?? [];
  const ownerUnitData = analytics?.ownerUnits ?? [];
  const selectedUnitName = units.find((unit: any) => unit.id === filters.unitId)?.name;
  const scopeLabel = selectedUnitName || "all scoped units";

  const analyticsCards = analytics
    ? [
        {
          title: "Scoped Trainings",
          value: formatNumber(analytics.summary.totalTrainings),
          description: `${formatDecimal(analytics.summary.approvalRate)}% approved or locked`,
          icon: GraduationCap,
        },
        {
          title: "Unique Participants",
          value: formatNumber(analytics.summary.uniqueParticipants),
          description: `${formatNumber(analytics.summary.participantRecords)} approved attendance records`,
          icon: Users2,
        },
        {
          title: "Credited Hours",
          value: formatDecimal(analytics.summary.totalCreditedHours, 1),
          description: `${formatDecimal(analytics.summary.averageHoursPerTraining)} planned hours per training`,
          icon: Clock3,
        },
        {
          title: "Mandatory Share",
          value: `${formatDecimal(analytics.summary.mandatoryShare)}%`,
          description: `${formatNumber(analytics.summary.mandatoryTrainings)} mandatory vs ${formatNumber(analytics.summary.optionalTrainings)} optional`,
          icon: ShieldCheck,
        },
        {
          title: "Avg Reach",
          value: formatDecimal(analytics.summary.averageParticipantsPerTraining),
          description: analytics.summary.dominantDeliveryMode
            ? `${analytics.summary.dominantDeliveryMode} is the dominant mode`
            : "No dominant delivery mode yet",
          icon: BarChart3,
        },
      ]
    : [];

  const handleExport = (endpoint: string) => {
    const exportQuery = `${baseQuery}${baseQuery ? "&" : ""}format=csv`;
    window.open(`${endpoint}?${exportQuery}`, "_blank");
  };

  const getPaginationLabel = <T,>(data?: ReportResponse<T>) => {
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
    (!analytics && analyticsLoading) ||
    (!hoursByEmployee && hoursByEmployeeLoading) ||
    (!hoursByUnit && hoursByUnitLoading);
  const isRefreshing = analyticsFetching || hoursByEmployeeFetching || hoursByUnitFetching;

  if (isPageLoading) {
    return <LoadingState label="Loading reports..." className="min-h-[520px]" />;
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-2">
          <h1 className="text-2xl font-display font-bold">Reports & Analytics</h1>
          <p className="text-muted-foreground">
            Review training reach, portfolio mix, and credited hours for {scopeLabel}.
          </p>
        </div>
        {isRefreshing ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Refreshing...
          </div>
        ) : null}
      </div>

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

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-display font-semibold">Training Analytics</h2>
          <Button
            variant="outline"
            onClick={() => {
              if (!analytics) return;
              downloadCsvFile("training-analytics.csv", buildTrainingAnalyticsExportCsv(analytics));
            }}
          >
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {analyticsCards.map((item) => (
            <Card key={item.title} className="border-border/60">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{item.title}</CardTitle>
                <item.icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold">{item.value}</div>
                <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="relative z-0 overflow-visible border-border/60">
            <CardHeader>
              <CardTitle>Training Delivery Distribution</CardTitle>
              <CardDescription>Share of trainings grouped by delivery mode.</CardDescription>
            </CardHeader>
            <CardContent>
              {deliveryModeData.length > 0 ? (
                <ChartContainer
                  config={deliveryChartConfig}
                  className="mx-auto h-[260px] w-full max-w-[320px] aspect-auto"
                >
                  <PieChart>
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          hideLabel
                          formatter={(value, _name, item) => (
                            <div className="flex w-full items-center justify-between gap-3">
                              <span>{item.payload.label}</span>
                              <span className="font-mono tabular-nums">
                                {value} ({item.payload.sharePercent}%)
                              </span>
                            </div>
                          )}
                        />
                      }
                    />
                    <Pie
                      data={deliveryModeData}
                      dataKey="count"
                      nameKey="deliveryMode"
                      innerRadius={58}
                      strokeWidth={4}
                    >
                      {deliveryModeData.map((entry, index) => (
                        <Cell
                          key={entry.deliveryMode}
                          fill={
                            pieColors[index] ||
                            `var(--color-${entry.deliveryMode})`
                          }
                        />
                      ))}
                    </Pie>
                    <ChartLegend content={<ChartLegendContent nameKey="deliveryMode" />} />
                  </PieChart>
                </ChartContainer>
              ) : (
                <EmptyChartState label="No scoped delivery-mode data yet." />
              )}
            </CardContent>
          </Card>

          <Card className="relative z-20 overflow-visible border-border/60">
            <CardHeader>
              <CardTitle>Highest-Participation Trainings</CardTitle>
              <CardDescription>Trainings with the most unique participants.</CardDescription>
            </CardHeader>
            <CardContent>
              {topTrainingData.length > 0 ? (
                <ChartContainer
                  config={trainingReachChartConfig}
                  className="h-[260px] w-full aspect-auto overflow-visible"
                >
                  <BarChart
                    accessibilityLayer
                    data={topTrainingData}
                    layout="vertical"
                    margin={{ left: 8, right: 12 }}
                  >
                    <CartesianGrid horizontal={false} />
                    <XAxis type="number" hide />
                    <YAxis
                      dataKey="shortTitle"
                      type="category"
                      width={170}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(value: string) => truncateLabel(value, 26)}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          hideLabel
                          hideIndicator
                          formatter={(value, _name, item) => (
                            <div className="space-y-1">
                              <div className="font-medium leading-snug">{item.payload.title}</div>
                              <div className="text-muted-foreground">
                                {value} participants
                              </div>
                              <div className="text-muted-foreground">
                                {formatDecimal(item.payload.totalHoursCredited, 1)} credited hours
                              </div>
                            </div>
                          )}
                        />
                      }
                    />
                    <Bar
                      dataKey="participants"
                      radius={6}
                      fill="var(--color-participants)"
                    />
                  </BarChart>
                </ChartContainer>
              ) : (
                <EmptyChartState label="No scoped participant data yet." />
              )}
            </CardContent>
          </Card>

          <Card className="relative z-0 overflow-visible border-border/60">
            <CardHeader>
              <CardTitle>Training Hours by Owning Unit</CardTitle>
              <CardDescription>Approved and locked credited hours grouped by training owner.</CardDescription>
            </CardHeader>
            <CardContent>
              {ownerUnitData.length > 0 ? (
                <ChartContainer
                  config={ownerHoursChartConfig}
                  className="h-[260px] w-full aspect-auto overflow-visible"
                >
                  <BarChart accessibilityLayer data={ownerUnitData} margin={{ left: 8, right: 12 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="unitName"
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                      angle={-20}
                      textAnchor="end"
                      height={64}
                      tickFormatter={(value: string) => truncateLabel(value, 24)}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={
                        <ChartTooltipContent
                          hideLabel
                          hideIndicator
                          formatter={(value, _name, item) => (
                            <div className="space-y-1">
                              <div className="font-medium">{item.payload.unitName}</div>
                              <div className="text-muted-foreground">
                                {formatDecimal(Number(value), 1)} credited hours
                              </div>
                              <div className="text-muted-foreground">
                                {item.payload.trainingCount} trainings, {item.payload.participants} participants
                              </div>
                            </div>
                          )}
                        />
                      }
                    />
                    <Bar
                      dataKey="totalHoursCredited"
                      radius={6}
                      fill="var(--color-totalHoursCredited)"
                    />
                  </BarChart>
                </ChartContainer>
              ) : (
                <EmptyChartState label="No scoped unit contribution data yet." />
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="border-border/60">
          <CardHeader>
            <CardTitle>Training Insights</CardTitle>
            <CardDescription>Summary observations from the current filtered training data.</CardDescription>
          </CardHeader>
          <CardContent>
            {analytics?.insights?.length ? (
              <ul className="space-y-3 text-sm text-muted-foreground">
                {analytics.insights.map((insight) => (
                  <li key={insight} className="rounded-md border bg-muted/20 px-3 py-2 text-foreground/85">
                    {insight}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No additional insights available.</p>
            )}
          </CardContent>
        </Card>
      </section>

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
              {(hoursByEmployee?.rows ?? []).map((row) => (
                <TableRow key={row.employeeId}>
                  <TableCell>{row.employeeNo}</TableCell>
                  <TableCell>{row.fullName}</TableCell>
                  <TableCell>{formatDecimal(Number(row.totalHours), 2)}</TableCell>
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
              {(hoursByUnit?.rows ?? []).map((row) => (
                <TableRow key={row.unitId}>
                  <TableCell>{row.unitName}</TableCell>
                  <TableCell>{formatDecimal(Number(row.totalHours), 2)}</TableCell>
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
