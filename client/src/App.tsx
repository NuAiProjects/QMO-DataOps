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
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useUser } from "@/hooks/use-user";

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useUser();

  if (isLoading) {
    return null;
  }

  if (!user) {
    return <Redirect to="/login" />;
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
          if (isLoading) return null;
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
