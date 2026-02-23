import { useEffect, useRef, useState } from "react";
import { useUser } from "@/hooks/use-user";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Users,
  Calendar,
  ClipboardCheck,
  FileText,
  LogOut,
  Menu,
  Bell,
  Search,
  Settings,
  ShieldCheck,
  File,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import logo from "@/assets/logo.png";
import { Input } from "@/components/ui/input";
import { useQuery } from "@tanstack/react-query";
import { getQueryFn } from "@/lib/queryClient";

type SearchResult = {
  id: string;
  type: "employee" | "training" | "document";
  title: string;
  subtitle: string;
  href: string;
};

type DashboardActivity = {
  id: string;
  kind: "employee" | "training" | "attendance";
  title: string;
  subtitle: string;
  href: string;
  createdAt: string;
};

type ApprovalsResponse = {
  training: { submitted: unknown[] };
  attendance: { submitted: unknown[] };
};

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

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useUser();
  const [location, navigate] = useLocation();
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm.trim());
    }, 250);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (!searchContainerRef.current) return;
      if (searchContainerRef.current.contains(event.target as Node)) return;
      setSearchOpen(false);
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, []);

  if (!user) return null;

  const canApprove = user.role === "super_admin" || user.role === "hr_qa_approver";

  const roleLabels: Record<string, string> = {
    super_admin: "Super Admin",
    hr_qa_approver: "HR/QA Approver",
    unit_head: "Unit Head",
    encoder: "Encoder",
    viewer_auditor: "Viewer/Auditor",
  };

  const navItems = [
    {
      label: "Dashboard",
      href: "/dashboard",
      icon: LayoutDashboard,
      roles: ["super_admin", "hr_qa_approver", "unit_head", "encoder", "viewer_auditor"],
    },
    {
      label: "Employees",
      href: "/employees",
      icon: Users,
      roles: ["super_admin", "hr_qa_approver", "unit_head", "encoder", "viewer_auditor"],
    },
    {
      label: "Trainings",
      href: "/trainings",
      icon: Calendar,
      roles: ["super_admin", "hr_qa_approver", "unit_head", "encoder", "viewer_auditor"],
    },
    {
      label: "Attendance",
      href: "/attendance",
      icon: ClipboardCheck,
      roles: ["super_admin", "unit_head", "encoder", "viewer_auditor"],
    },
    {
      label: "Approvals",
      href: "/approvals",
      icon: ShieldCheck,
      roles: ["super_admin", "hr_qa_approver"],
    },
    {
      label: "Reports",
      href: "/reports",
      icon: FileText,
      roles: ["super_admin", "hr_qa_approver", "viewer_auditor"],
    },
  ];

  const filteredNav = navItems.filter((item) => item.roles.includes(user.role));
  const avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(user.fullName)}`;

  const { data: searchData, isFetching: isSearching } = useQuery<{ results: SearchResult[] }>({
    queryKey: ["/api/search", debouncedSearch],
    queryFn: () =>
      fetchJson<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(debouncedSearch)}`),
    enabled: debouncedSearch.length >= 2,
  });

  const { data: activityData } = useQuery<{ activities: DashboardActivity[] }>({
    queryKey: ["/api/dashboard/activities", "layout", "6"],
    queryFn: () => fetchJson<{ activities: DashboardActivity[] }>("/api/dashboard/activities?limit=6"),
  });

  const { data: approvalsData } = useQuery<ApprovalsResponse>({
    queryKey: ["/api/approvals"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: canApprove,
  });

  const searchResults = searchData?.results ?? [];
  const notifications = activityData?.activities ?? [];
  const pendingApprovals = canApprove
    ? (approvalsData?.training?.submitted?.length ?? 0) +
      (approvalsData?.attendance?.submitted?.length ?? 0)
    : 0;
  const hasNotifications = pendingApprovals > 0 || notifications.length > 0;

  const handleSelectSearchResult = (href: string) => {
    setSearchTerm("");
    setDebouncedSearch("");
    setSearchOpen(false);
    navigate(href);
  };

  const Sidebar = () => (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
      <div className="p-6 flex items-center gap-3">
        <img src={logo} alt="Logo" className="h-10 w-10 object-contain" />
        <div className="flex flex-col">
          <span className="font-display font-bold text-lg leading-tight">QMO DataOps</span>
          <span className="text-xs text-sidebar-foreground/60">National University</span>
        </div>
      </div>

      <div className="px-3 py-2">
        <div className="mb-2 px-4 text-xs font-semibold text-sidebar-foreground/50 uppercase tracking-wider">
          Menu
        </div>
        <nav className="space-y-1">
          {filteredNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-4 py-3 text-sm font-medium rounded-md transition-colors ${
                location === item.href
                  ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              }`}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="mt-auto p-4 border-t border-sidebar-border">
        <div className="flex items-center gap-3 p-2 rounded-md bg-sidebar-accent/50">
          <Avatar className="h-9 w-9 border border-sidebar-border">
            <AvatarImage src={avatarUrl} />
            <AvatarFallback>{user.fullName.charAt(0)}</AvatarFallback>
          </Avatar>
          <div className="flex-1 overflow-hidden">
            <p className="text-sm font-medium truncate">{user.fullName}</p>
            <p className="text-xs text-sidebar-foreground/60 truncate">
              {roleLabels[user.role] ?? user.role}
            </p>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background flex">
      <div className="hidden md:block w-64 fixed inset-y-0 z-50">
        <Sidebar />
      </div>

      <div className="md:hidden">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="fixed top-4 left-4 z-50">
              <Menu className="h-6 w-6" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="p-0 w-64 border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
          >
            <Sidebar />
          </SheetContent>
        </Sheet>
      </div>

      <div className="flex-1 md:ml-64 flex flex-col min-h-screen">
        <header className="sticky top-0 z-40 h-16 bg-background/80 backdrop-blur-md border-b flex items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <div ref={searchContainerRef} className="relative hidden md:block w-96">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search events, employees, or documents..."
                className="pl-9 bg-muted/50 border-none focus-visible:ring-1"
                value={searchTerm}
                onFocus={() => setSearchOpen(true)}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setSearchOpen(true);
                }}
              />

              {searchOpen && debouncedSearch.length >= 2 ? (
                <div className="absolute top-11 z-50 w-full rounded-md border border-border bg-card shadow-md">
                  {isSearching ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">Searching...</div>
                  ) : searchResults.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">No results found.</div>
                  ) : (
                    <div className="max-h-80 overflow-y-auto py-1">
                      {searchResults.map((result) => (
                        <button
                          key={result.id}
                          type="button"
                          className="w-full px-3 py-2 text-left hover:bg-muted/50 transition-colors"
                          onClick={() => handleSelectSearchResult(result.href)}
                        >
                          <div className="text-sm font-medium leading-tight">{result.title}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {result.type.toUpperCase()} - {result.subtitle}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative text-muted-foreground hover:text-foreground"
                >
                  <Bell className="h-5 w-5" />
                  {hasNotifications ? (
                    <span className="absolute top-1.5 right-1.5 h-2.5 w-2.5 bg-red-500 rounded-full border-2 border-background" />
                  ) : null}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuLabel className="flex items-center justify-between gap-3">
                  <span>Notifications</span>
                  {pendingApprovals > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {pendingApprovals} pending approval{pendingApprovals === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {notifications.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                    No recent updates.
                  </div>
                ) : (
                  notifications.map((item) => {
                    const Icon =
                      item.kind === "employee"
                        ? Users
                        : item.kind === "attendance"
                          ? ClipboardCheck
                          : Calendar;
                    return (
                      <DropdownMenuItem
                        key={item.id}
                        className="items-start gap-3 py-3"
                        onSelect={(event) => {
                          event.preventDefault();
                          navigate(item.href);
                        }}
                      >
                        <Icon className="h-4 w-4 mt-0.5 text-muted-foreground" />
                        <div className="space-y-0.5">
                          <p className="text-sm font-medium leading-tight">{item.title}</p>
                          <p className="text-xs text-muted-foreground">{formatRelativeTime(item.createdAt)}</p>
                        </div>
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground">
                  <Settings className="h-5 w-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>My Account</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={(event) => event.preventDefault()}>
                  <Users className="mr-2 h-4 w-4" />
                  Profile Settings
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={(event) => event.preventDefault()}>
                  <File className="mr-2 h-4 w-4" />
                  Help & Support
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout} className="text-destructive">
                  <LogOut className="mr-2 h-4 w-4" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 p-6 md:p-8 overflow-y-auto">
          <div className="max-w-7xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
