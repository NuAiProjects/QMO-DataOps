import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
  Card, 
  CardContent, 
  CardFooter, 
  CardHeader, 
  CardTitle,
  CardDescription
} from "@/components/ui/card";
import { 
  Calendar as CalendarIcon, 
  Users, 
  Clock, 
  MoreVertical,
  Plus
} from "lucide-react";
import { useUser } from "@/hooks/use-user";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, getQueryFn, queryClient } from "@/lib/queryClient";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function Trainings() {
  const { user } = useUser();
  const { toast } = useToast();
  const [filter, setFilter] = useState("All");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [form, setForm] = useState({
    title: "",
    description: "",
    category: "",
    deliveryMode: "in_person",
    provider: "",
    startDate: "",
    endDate: "",
    hours: "0",
    ownerUnitId: "",
    visibilityScope: "unit",
    isMandatory: false,
  });

  const canCreate = user?.role !== "viewer_auditor";
  const canSubmit = ["encoder", "unit_head", "super_admin"].includes(user?.role || "");

  const { data, isLoading: trainingsLoading } = useQuery({
    queryKey: ["/api/training-events"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: unitData, isLoading: unitsLoading } = useQuery({
    queryKey: ["/api/units"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const events = data?.trainingEvents ?? [];
  const units = unitData?.units ?? [];
  const filtered = useMemo(() => {
    if (filter === "All") return events;
    return events.filter((event: any) => {
      if (filter === "Drafts") return event.workflowStatus === "draft";
      if (filter === "Submitted") return event.workflowStatus === "submitted";
      if (filter === "Approved") return event.workflowStatus === "approved";
      if (filter === "Locked") return event.workflowStatus === "locked";
      return true;
    });
  }, [events, filter]);
  const isPageLoading = trainingsLoading || unitsLoading;

  useEffect(() => {
    if (!form.ownerUnitId && units.length > 0) {
      setForm((prev) => ({ ...prev, ownerUnitId: units[0].id }));
    }
  }, [units, form.ownerUnitId]);

  const handleCreate = async () => {
    const ownerUnitId = form.ownerUnitId || units[0]?.id;
    if (!form.title.trim()) {
      toast({ variant: "destructive", title: "Title is required." });
      return;
    }
    if (!form.startDate || !form.endDate) {
      toast({ variant: "destructive", title: "Start and end dates are required." });
      return;
    }
    if (!ownerUnitId) {
      toast({ variant: "destructive", title: "Select an owner unit." });
      return;
    }
    const hours = Number(form.hours);
    if (!Number.isFinite(hours) || hours <= 0) {
      toast({ variant: "destructive", title: "Hours must be greater than 0." });
      return;
    }

    try {
      await apiRequest("POST", "/api/training-events", {
        ...form,
        title: form.title.trim(),
        description: form.description?.trim() || null,
        category: form.category?.trim() || null,
        provider: form.provider?.trim() || null,
        hours,
        ownerUnitId,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/training-events"] });
      setIsDialogOpen(false);
      setForm({
        title: "",
        description: "",
        category: "",
        deliveryMode: "in_person",
        provider: "",
        startDate: "",
        endDate: "",
        hours: "0",
        ownerUnitId: "",
        visibilityScope: "unit",
        isMandatory: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to create event.";
      toast({
        variant: "destructive",
        title: "Failed to create event",
        description: message.replace(/^Error:\s*/, ""),
      });
    }
  };

  const handleSubmit = async (eventId: string) => {
    await apiRequest("POST", `/api/training-events/${eventId}/submit`);
    queryClient.invalidateQueries({ queryKey: ["/api/training-events"] });
    queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
  };

  if (isPageLoading) {
    return <LoadingState label="Loading training events..." className="min-h-[420px]" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold">Training Events</h1>
          <p className="text-muted-foreground">Browse and manage upcoming seminars and workshops.</p>
        </div>
        {canCreate && (
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button className="shadow-md">
                <Plus className="mr-2 h-4 w-4" />
                Create Event
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New Training Event</DialogTitle>
                <DialogDescription className="sr-only">
                  Create a new training event for your unit.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <Input
                  placeholder="Title"
                  value={form.title}
                  onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                />
                <Input
                  placeholder="Category"
                  value={form.category}
                  onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
                />
                <Input
                  placeholder="Provider"
                  value={form.provider}
                  onChange={(e) => setForm((prev) => ({ ...prev, provider: e.target.value }))}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="date"
                    value={form.startDate}
                    onChange={(e) => setForm((prev) => ({ ...prev, startDate: e.target.value }))}
                  />
                  <Input
                    type="date"
                    value={form.endDate}
                    onChange={(e) => setForm((prev) => ({ ...prev, endDate: e.target.value }))}
                  />
                </div>
                <Input
                  placeholder="Hours"
                  type="number"
                  value={form.hours}
                  onChange={(e) => setForm((prev) => ({ ...prev, hours: e.target.value }))}
                />
                <Select
                  value={form.deliveryMode}
                  onValueChange={(value) => setForm((prev) => ({ ...prev, deliveryMode: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Delivery Mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="in_person">In Person</SelectItem>
                    <SelectItem value="virtual">Virtual</SelectItem>
                    <SelectItem value="hybrid">Hybrid</SelectItem>
                    <SelectItem value="self_paced">Self Paced</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={form.ownerUnitId}
                  onValueChange={(value) => setForm((prev) => ({ ...prev, ownerUnitId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Owner Unit" />
                  </SelectTrigger>
                  <SelectContent>
                    {units.map((unit: any) => (
                      <SelectItem key={unit.id} value={unit.id}>
                        {unit.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={form.visibilityScope}
                  onValueChange={(value) => setForm((prev) => ({ ...prev, visibilityScope: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Visibility" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unit">Unit</SelectItem>
                    <SelectItem value="department">Department</SelectItem>
                    <SelectItem value="org">Organization</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={form.isMandatory ? "yes" : "no"}
                  onValueChange={(value) =>
                    setForm((prev) => ({ ...prev, isMandatory: value === "yes" }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Mandatory" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">Mandatory</SelectItem>
                    <SelectItem value="no">Optional</SelectItem>
                  </SelectContent>
                </Select>
                <Button onClick={handleCreate}>Create Event</Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="flex items-center gap-4 overflow-x-auto pb-2">
        {["All", "Drafts", "Submitted", "Approved", "Locked"].map((f) => (
          <Button
            key={f}
            variant={filter === f ? "default" : "outline"}
            onClick={() => setFilter(f)}
            className="rounded-full"
            size="sm"
          >
            {f}
          </Button>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map((event: any) => (
          <Card key={event.id} className="group hover:shadow-lg transition-all border-border/60">
            <CardHeader>
              <div className="flex justify-between items-start">
                <Badge variant="outline" className="mb-2 w-fit bg-primary/5 text-primary border-primary/20">
                  {event.category || event.deliveryMode}
                </Badge>
                <Button variant="ghost" size="icon" className="-mr-2 -mt-2 h-8 w-8 text-muted-foreground">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </div>
              <CardTitle className="line-clamp-2 leading-tight h-12">
                {event.title}
              </CardTitle>
              <CardDescription className="flex items-center mt-1">
                <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                {new Date(event.startDate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm text-muted-foreground">
                <div className="flex items-center">
                  <Clock className="mr-2 h-3.5 w-3.5" />
                  {event.hours} Hours Credit
                </div>
                <div className="flex items-center">
                  <Users className="mr-2 h-3.5 w-3.5" />
                  {event.provider || "Internal"}
                </div>
              </div>
            </CardContent>
            <CardFooter className="pt-2 border-t bg-muted/20">
              <div className="flex w-full items-center justify-between">
                <Badge variant="outline">
                  {event.workflowStatus}
                </Badge>
                <div className="flex items-center gap-2">
                  {canSubmit && (event.workflowStatus === "draft" || event.workflowStatus === "returned") ? (
                    <Button variant="outline" size="sm" onClick={() => handleSubmit(event.id)}>
                      Submit
                    </Button>
                  ) : null}
                  <Button variant="link" size="sm" className="h-auto p-0">
                    View Details
                  </Button>
                </div>
              </div>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}
