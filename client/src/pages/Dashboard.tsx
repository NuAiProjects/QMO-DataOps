import { useUser } from "@/hooks/use-user";
import { mockEmployees, mockTrainings } from "@/lib/mockData";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  Users, 
  Calendar, 
  CheckCircle2, 
  AlertCircle, 
  TrendingUp,
  Clock,
  FileBarChart
} from "lucide-react";

export default function Dashboard() {
  const { user } = useUser();

  const stats = [
    {
      title: "Total Employees",
      value: mockEmployees.length.toString(),
      description: "+2 from last month",
      icon: Users,
      color: "text-blue-500",
      bg: "bg-blue-50 dark:bg-blue-900/20"
    },
    {
      title: "Active Trainings",
      value: mockTrainings.filter(t => t.status === 'Upcoming').length.toString(),
      description: "Upcoming events",
      icon: Calendar,
      color: "text-amber-500",
      bg: "bg-amber-50 dark:bg-amber-900/20"
    },
    {
      title: "Pending Approvals",
      value: "5",
      description: "Requires attention",
      icon: AlertCircle,
      color: "text-red-500",
      bg: "bg-red-50 dark:bg-red-900/20"
    },
    {
      title: "Completion Rate",
      value: "92%",
      description: "Target: 85%",
      icon: CheckCircle2,
      color: "text-emerald-500",
      bg: "bg-emerald-50 dark:bg-emerald-900/20"
    }
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-display font-bold text-foreground">
          Welcome back, {user?.name.split(' ')[0]}
        </h1>
        <p className="text-muted-foreground mt-2">
          Here's what's happening in your department today.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat, i) => (
          <Card key={i} className="border-border/50 shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">
                {stat.title}
              </CardTitle>
              <div className={`p-2 rounded-full ${stat.bg}`}>
                <stat.icon className={`h-4 w-4 ${stat.color}`} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {stat.description}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4 border-border/50 shadow-sm">
          <CardHeader>
            <CardTitle>Training Participation</CardTitle>
            <CardDescription>
              Employee attendance over the last 6 months
            </CardDescription>
          </CardHeader>
          <CardContent className="pl-2">
            <div className="h-[200px] flex items-center justify-center text-muted-foreground bg-muted/20 rounded-md border border-dashed">
              <TrendingUp className="mr-2 h-4 w-4" />
              Chart Placeholder (Recharts would go here)
            </div>
          </CardContent>
        </Card>
        
        <Card className="col-span-3 border-border/50 shadow-sm">
          <CardHeader>
            <CardTitle>Recent Activities</CardTitle>
            <CardDescription>
              Latest updates and submissions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-8">
              {[
                { text: "New training event created: AI in Education", time: "2 hours ago", icon: Calendar },
                { text: "Attendance report submitted for review", time: "4 hours ago", icon: FileBarChart },
                { text: "New employee profile added: Juan Dela Cruz", time: "Yesterday", icon: Users },
                { text: "Policy update pending approval", time: "Yesterday", icon: Clock },
              ].map((item, index) => (
                <div className="flex items-center" key={index}>
                  <div className="space-y-1">
                    <p className="text-sm font-medium leading-none">{item.text}</p>
                    <p className="text-xs text-muted-foreground">{item.time}</p>
                  </div>
                  <div className="ml-auto font-medium">
                    <item.icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
