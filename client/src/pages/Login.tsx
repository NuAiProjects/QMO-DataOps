import { useUser, Role } from "@/hooks/use-user";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useState } from "react";
import logo from "@/assets/logo.png";

export default function Login() {
  const { login } = useUser();
  const [, setLocation] = useLocation();
  const [role, setRole] = useState<Role>('Super Admin');

  const handleLogin = () => {
    login(role);
    setLocation("/dashboard");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute inset-0 bg-grid-slate-100 [mask-image:linear-gradient(0deg,white,rgba(255,255,255,0.6))] dark:bg-grid-slate-700/25 dark:[mask-image:linear-gradient(0deg,rgba(255,255,255,0.1),rgba(255,255,255,0.5))]" />
      
      <div className="relative z-10 w-full max-w-md px-4">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="h-24 w-24 rounded-full bg-white shadow-xl p-4 flex items-center justify-center mb-6 ring-4 ring-primary/20">
            <img src={logo} alt="National University Logo" className="h-full w-full object-contain" />
          </div>
          <h1 className="text-3xl font-display font-bold text-foreground tracking-tight">QMO Data Hub</h1>
          <p className="text-muted-foreground mt-2 text-lg">National University Manila</p>
        </div>

        <Card className="border-border/50 shadow-2xl backdrop-blur-sm bg-card/95">
          <CardHeader>
            <CardTitle>Sign In</CardTitle>
            <CardDescription>Select your role to access the dashboard</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">Role</label>
              <Select value={role} onValueChange={(val: Role) => setRole(val)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Super Admin">Super Admin</SelectItem>
                  <SelectItem value="HR/QA Approver">HR/QA Approver</SelectItem>
                  <SelectItem value="Unit Head">Unit Head</SelectItem>
                  <SelectItem value="Encoder">Encoder</SelectItem>
                  <SelectItem value="Viewer/Auditor">Viewer/Auditor</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
          <CardFooter>
            <Button className="w-full h-11 text-base font-semibold shadow-lg shadow-primary/20 hover:shadow-primary/40 transition-all" onClick={handleLogin}>
              Enter Dashboard
            </Button>
          </CardFooter>
        </Card>
        
        <p className="text-center text-xs text-muted-foreground mt-8">
          © 2025 National University. All rights reserved. <br/>
          Quality Management Office
        </p>
      </div>
    </div>
  );
}
