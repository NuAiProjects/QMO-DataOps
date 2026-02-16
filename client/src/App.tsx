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
import DashboardLayout from "@/components/layout/DashboardLayout";
import { useUser } from "@/hooks/use-user";

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { user } = useUser();
  
  if (!user) {
    return <Redirect to="/" />;
  }

  return (
    <DashboardLayout>
      <Component />
    </DashboardLayout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Login} />
      
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

      {/* Placeholders for other routes */}
      <Route path="/reports">
        {() => <ProtectedRoute component={() => <div className="text-center p-10 text-muted-foreground">Reports Module Placeholder</div>} />}
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
