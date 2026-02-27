import { useMemo } from "react";
import { useUser } from "@/hooks/use-user";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { Users, Calendar, CheckCircle2, AlertCircle, FileBarChart, TrendingUp } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { CartesianGrid, Line, LineChart, XAxis } from "recharts";

type AttendanceRow = {
  attendanceDate: string;
  attendanceStatus: "present" | "absent" | "partial";
};

type EmployeesResponse = {
  employees: Array<{ id: string }>;
};

type TrainingsResponse = {
  trainingEvents: Array<{ id: string; workflowStatus: string }>;
};

type AttendanceResponse = {
  attendance: AttendanceRow[];
};

type ApprovalsResponse = {
  training: { submitted: unknown[] };
  attendance: { submitted: unknown[] };
};

type ComplianceResponse = {
  rows: Array<{ compliancePercent: number }>;
};

type DashboardActivity = {
  id: string;
  kind: "employee" | "training" | "attendance";
  title: string;
  subtitle: string;
  href: string;
  createdAt: string;
};

const participationChartConfig = {
  participants: {
    label: "Participants",
    color: "hsl(var(--chart-1))",
  },
} satisfies ChartConfig;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}`);
  }
  return res.json();
}

function formatRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "Unknown time";
  const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function parseYearMonth(value: string) {
  const [yearRaw, monthRaw] = value.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  return { year, month };
}

export default function Dashboard() {
  const { user } = useUser();

  const { data: employeesData, isLoading: employeesLoading } = useQuery<EmployeesResponse>({
    queryKey: ["/api/employees"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: trainingsData, isLoading: trainingsLoading } = useQuery<TrainingsResponse>({
    queryKey: ["/api/training-events"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: attendanceData, isLoading: attendanceLoading } = useQuery<AttendanceResponse>({
    queryKey: ["/api/attendance"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: activityData, isLoading: activityLoading } = useQuery<{ activities: DashboardActivity[] }>({
    queryKey: ["/api/dashboard/activities", "dashboard", "8"],
    queryFn: () => fetchJson<{ activities: DashboardActivity[] }>("/api/dashboard/activities?limit=8"),
  });

  const canApprove = user?.role === "super_admin" || user?.role === "hr_qa_approver";
  const { data: approvalsData, isLoading: approvalsLoading } = useQuery<ApprovalsResponse>({
    queryKey: ["/api/approvals"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: !!user && canApprove,
  });
  const { data: complianceData, isLoading: complianceLoading } = useQuery<ComplianceResponse>({
    queryKey: ["/api/reports/compliance", ""],
    queryFn: () => fetchJson<ComplianceResponse>("/api/reports/compliance"),
  });

  const totalEmployees = employeesData?.employees?.length ?? 0;
  const trainings = trainingsData?.trainingEvents ?? [];
  const attendance = attendanceData?.attendance ?? [];
  const activities = activityData?.activities ?? [];

  const activeTrainings = trainings.filter((t) => t.workflowStatus !== "draft").length;
  const pendingApprovals = canApprove
    ? (approvalsData?.training?.submitted?.length ?? 0) +
      (approvalsData?.attendance?.submitted?.length ?? 0)
    : 0;

  const complianceRows = complianceData?.rows ?? [];
  const averageCompliance =
    complianceRows.length === 0
      ? 0
      : Math.round(
          complianceRows.reduce((acc, row) => acc + row.compliancePercent, 0) / complianceRows.length,
        );

  const participationData = useMemo(() => {
    const now = new Date();
    const months = Array.from({ length: 6 }, (_, index) => {
      const date = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1);
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      return {
        key: `${year}-${String(month).padStart(2, "0")}`,
        month: date.toLocaleDateString("en-US", { month: "short" }),
        participants: 0,
      };
    });

    const monthIndexByKey = new Map(months.map((entry, index) => [entry.key, index]));

    for (const row of attendance) {
      if (row.attendanceStatus === "absent") continue;
      const parsed = parseYearMonth(row.attendanceDate);
      if (!parsed) continue;
      const key = `${parsed.year}-${String(parsed.month).padStart(2, "0")}`;
      const monthIndex = monthIndexByKey.get(key);
      if (monthIndex === undefined) continue;
      months[monthIndex].participants += 1;
    }

    return months;
  }, [attendance]);

  const hasParticipationData = participationData.some((point) => point.participants > 0);

  const stats = [
    {
      title: "Total Employees",
      value: totalEmployees.toString(),
      description: "Within your scope",
      icon: Users,
      color: "text-blue-500",
      bg: "bg-blue-50 dark:bg-blue-900/20",
    },
    {
      title: "Active Trainings",
      value: activeTrainings.toString(),
      description: "Active or submitted events",
      icon: Calendar,
      color: "text-amber-500",
      bg: "bg-amber-50 dark:bg-amber-900/20",
    },
    {
      title: "Pending Approvals",
      value: pendingApprovals.toString(),
      description: "Requires review",
      icon: AlertCircle,
      color: "text-red-500",
      bg: "bg-red-50 dark:bg-red-900/20",
    },
    {
      title: "Completion Rate",
      value: `${averageCompliance}%`,
      description: "Mandatory training compliance",
      icon: CheckCircle2,
      color: "text-emerald-500",
      bg: "bg-emerald-50 dark:bg-emerald-900/20",
    },
  ];

  const isPageLoading =
    employeesLoading ||
    trainingsLoading ||
    attendanceLoading ||
    activityLoading ||
    complianceLoading ||
    (canApprove && approvalsLoading);

  if (isPageLoading) {
    return <LoadingState label="Loading dashboard data..." className="min-h-[520px]" />;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">
          Welcome back, {user?.fullName?.split(" ")[0] || "User"}
        </h1>
        <p className="text-muted-foreground mt-2">Here&apos;s what&apos;s happening in your department today.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.title} className="border-border/50 shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
              <div className={`p-2 rounded-full ${stat.bg}`}>
                <stat.icon className={`h-4 w-4 ${stat.color}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <p className="text-xs text-muted-foreground mt-1">{stat.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4 border-border/50 shadow-sm">
          <CardHeader>
            <CardTitle>Training Participation</CardTitle>
            <CardDescription>Employee attendance over the last 6 months</CardDescription>
          </CardHeader>
          <CardContent className="pl-2 pr-2">
            {hasParticipationData ? (
              <ChartContainer config={participationChartConfig} className="h-[240px] w-full aspect-auto">
                <LineChart accessibilityLayer data={participationData} margin={{ left: 8, right: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} tickMargin={8} />
                  <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
                  <Line
                    dataKey="participants"
                    type="monotone"
                    stroke="var(--color-participants)"
                    strokeWidth={2}
                    dot={{ fill: "var(--color-participants)", r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ChartContainer>
            ) : (
              <div className="h-[240px] flex items-center justify-center text-muted-foreground bg-muted/20 rounded-md border border-dashed">
                <TrendingUp className="mr-2 h-4 w-4" />
                No attendance data for the last 6 months
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-3 border-border/50 shadow-sm">
          <CardHeader>
            <CardTitle>Recent Activities</CardTitle>
            <CardDescription>Latest updates and submissions</CardDescription>
          </CardHeader>
          <CardContent>
            {activities.length === 0 ? (
              <div className="text-sm text-muted-foreground">No recent activities found.</div>
            ) : (
              <div className="space-y-6">
                {activities.map((item) => {
                  const Icon =
                    item.kind === "employee"
                      ? Users
                      : item.kind === "training"
                        ? Calendar
                        : FileBarChart;
                  return (
                    <div className="flex items-start" key={item.id}>
                      <div className="space-y-1">
                        <p className="text-sm font-medium leading-none">{item.title}</p>
                        <p className="text-xs text-muted-foreground">{formatRelativeTime(item.createdAt)}</p>
                      </div>
                      <div className="ml-auto font-medium">
                        <Icon className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
