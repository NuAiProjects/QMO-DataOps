import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Employees from "@/pages/Employees";
import Trainings from "@/pages/Trainings";
import Attendance from "@/pages/Attendance";
import Approvals from "@/pages/Approvals";
import Reports from "@/pages/Reports";
import Users from "@/pages/Users";
import Audit from "@/pages/Audit";
import DashboardLayout from "@/components/layout/DashboardLayout";
import { FullScreenLoader } from "@/components/ui/loading-state";
import { useUser } from "@/hooks/use-user";

function ProtectedRoute({
  component: Component,
  allowedRoles,
}: {
  component: React.ComponentType;
  allowedRoles?: string[];
}) {
  const { user, isLoading } = useUser();

  if (isLoading) {
    return <FullScreenLoader label="Loading your workspace..." />;
  }

  if (!user) {
    return <Redirect to="/login" />;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return <Redirect to="/dashboard" />;
  }

  return (
    <DashboardLayout>
      <Component />
    </DashboardLayout>
  );
}

function Router() {
  const { user, isLoading } = useUser();

  return (
    <Switch>
      <Route path="/">
        {() => {
          if (isLoading) return <FullScreenLoader label="Checking your session..." />;
          return user ? <Redirect to="/dashboard" /> : <Redirect to="/login" />;
        }}
      </Route>

      <Route path="/login" component={Login} />
      
      <Route path="/dashboard">
        {() => <ProtectedRoute component={Dashboard} />}
      </Route>
      
      <Route path="/employees">
        {() => <ProtectedRoute component={Employees} />}
      </Route>
      
      <Route path="/trainings">
        {() => <ProtectedRoute component={Trainings} />}
      </Route>

      <Route path="/attendance">
        {() => <ProtectedRoute component={Attendance} />}
      </Route>
      
      <Route path="/approvals">
        {() => <ProtectedRoute component={Approvals} />}
      </Route>

      <Route path="/reports">
        {() => <ProtectedRoute component={Reports} />}
      </Route>

      <Route path="/users">
        {() => <ProtectedRoute component={Users} allowedRoles={["super_admin"]} />}
      </Route>

      <Route path="/audit">
        {() => <ProtectedRoute component={Audit} />}
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
