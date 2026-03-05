import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Calendar as CalendarIcon, Users, Clock, MoreVertical, Plus, Copy } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";

type TrainingForm = {
  title: string;
  description: string;
  category: string;
  deliveryMode: string;
  provider: string;
  venue: string;
  startDate: string;
  endDate: string;
  hours: string;
  ownerUnitId: string;
  visibilityScope: string;
  isMandatory: boolean;
};

const emptyForm: TrainingForm = {
  title: "",
  description: "",
  category: "internal",
  deliveryMode: "in_person",
  provider: "",
  venue: "",
  startDate: "",
  endDate: "",
  hours: "0",
  ownerUnitId: "",
  visibilityScope: "unit",
  isMandatory: false,
};

const normalizeCategory = (value: unknown): "internal" | "external" => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "external" ? "external" : "internal";
};

const formatCategoryLabel = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  if (!normalized) return "";
  if (normalized.toLowerCase() === "internal") return "Internal";
  if (normalized.toLowerCase() === "external") return "External";
  return normalized;
};

export default function Trainings() {
  const { user } = useUser();
  const { toast } = useToast();
  const [filter, setFilter] = useState("All");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [detailsEvent, setDetailsEvent] = useState<any | null>(null);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [archiveTargetEvent, setArchiveTargetEvent] = useState<any | null>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [form, setForm] = useState<TrainingForm>(emptyForm);

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
  const { data: employeeData, isLoading: employeesLoading } = useQuery({
    queryKey: ["/api/employees"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const events = data?.trainingEvents ?? [];
  const units = unitData?.units ?? [];
  const employees = employeeData?.employees ?? [];
  const unitNameById = useMemo(() => {
    return new Map(units.map((unit: any) => [unit.id, unit.name]));
  }, [units]);
  const internalProviderOptions = useMemo(() => {
    const names = new Set<string>();
    for (const employee of employees) {
      const unitName = unitNameById.get(employee.unitId);
      if (typeof unitName === "string" && unitName.trim().length > 0) {
        names.add(unitName);
      }
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [employees, unitNameById]);
  const providerOptions = useMemo(() => {
    if (!form.provider) return internalProviderOptions;
    if (internalProviderOptions.includes(form.provider)) return internalProviderOptions;
    return [form.provider, ...internalProviderOptions];
  }, [internalProviderOptions, form.provider]);
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
  const isPageLoading = trainingsLoading || unitsLoading || employeesLoading;

  useEffect(() => {
    if (!form.ownerUnitId && units.length > 0) {
      setForm((prev) => ({ ...prev, ownerUnitId: units[0].id }));
    }
  }, [units, form.ownerUnitId]);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingEventId(null);
  };

  const mapEventToForm = (event: any): TrainingForm => ({
    title: event.title || "",
    description: event.description || "",
    category: normalizeCategory(event.category),
    deliveryMode: event.deliveryMode || "in_person",
    provider: event.provider || "",
    venue: event.venue || "",
    startDate: event.startDate || "",
    endDate: event.endDate || "",
    hours: String(event.hours ?? "0"),
    ownerUnitId: event.ownerUnitId || "",
    visibilityScope: event.visibilityScope || "unit",
    isMandatory: Boolean(event.isMandatory),
  });

  const openCreateDialog = () => {
    resetForm();
    setIsDialogOpen(true);
  };

  const openEditDialog = (event: any) => {
    setEditingEventId(event.id);
    setForm(mapEventToForm(event));
    setIsDialogOpen(true);
  };

  const copyAsTemplate = (event: any) => {
    setEditingEventId(null);
    setForm({
      ...mapEventToForm(event),
      title: `${event.title} (Copy)`,
      startDate: "",
      endDate: "",
    });
    setIsDialogOpen(true);
  };

  const handleCreateOrUpdate = async () => {
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
      toast({ variant: "destructive", title: "No owner unit available for your account." });
      return;
    }
    const provider = form.provider.trim();
    if (!provider) {
      toast({
        variant: "destructive",
        title:
          form.category === "external"
            ? "External provider is required."
            : "Select an internal provider.",
      });
      return;
    }
    const hours = Number(form.hours);
    if (!Number.isFinite(hours) || hours <= 0) {
      toast({ variant: "destructive", title: "Hours must be greater than 0." });
      return;
    }

    try {
      const payload = {
        title: form.title.trim(),
        description: form.description?.trim() || null,
        category: form.category,
        deliveryMode: form.deliveryMode,
        provider,
        venue: form.venue?.trim() || null,
        startDate: form.startDate,
        endDate: form.endDate,
        hours,
        ownerUnitId,
        visibilityScope: form.visibilityScope,
        isMandatory: form.isMandatory,
      };
      if (editingEventId) {
        await apiRequest("PUT", `/api/training-events/${editingEventId}`, payload);
      } else {
        await apiRequest("POST", "/api/training-events", payload);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/training-events"] });
      setIsDialogOpen(false);
      resetForm();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : editingEventId
            ? "Unable to update event."
            : "Unable to create event.";
      toast({
        variant: "destructive",
        title: editingEventId ? "Failed to update event" : "Failed to create event",
        description: message.replace(/^Error:\s*/, ""),
      });
    }
  };

  const handleSubmit = async (eventId: string) => {
    await apiRequest("POST", `/api/training-events/${eventId}/submit`);
    queryClient.invalidateQueries({ queryKey: ["/api/training-events"] });
    queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
  };

  const handleArchive = async () => {
    if (!archiveTargetEvent) return;
    await apiRequest("DELETE", `/api/training-events/${archiveTargetEvent.id}`, {
      reason: archiveReason.trim(),
    });
    await queryClient.invalidateQueries({ queryKey: ["/api/training-events"] });
    setArchiveDialogOpen(false);
    setArchiveTargetEvent(null);
    setArchiveReason("");
    if (detailsEvent?.id === archiveTargetEvent.id) {
      setDetailsEvent(null);
    }
  };

  if (isPageLoading) {
    return <LoadingState label="Loading training events..." className="min-h-[420px]" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-display font-bold">Training Events</h1>
          <p className="text-muted-foreground">Browse and manage upcoming seminars and workshops.</p>
        </div>
        {canCreate ? (
          <Dialog
            open={isDialogOpen}
            onOpenChange={(open) => {
              setIsDialogOpen(open);
              if (!open) {
                resetForm();
              }
            }}
          >
            <DialogTrigger asChild>
              <Button className="shadow-md" onClick={openCreateDialog}>
                <Plus className="mr-2 h-4 w-4" />
                Create Training/Workshop
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {editingEventId ? "Edit Training/Workshop" : "New Training/Workshop"}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Create or update a training/workshop event.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <Input
                  placeholder="Title"
                  value={form.title}
                  onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                />
                <Select
                  value={form.category}
                  onValueChange={(value) =>
                    setForm((prev) => ({ ...prev, category: value, provider: "" }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="internal">Internal</SelectItem>
                    <SelectItem value="external">External</SelectItem>
                  </SelectContent>
                </Select>
                {form.category === "external" ? (
                  <Input
                    placeholder="External Provider"
                    value={form.provider}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, provider: event.target.value }))
                    }
                  />
                ) : (
                  <Select
                    value={form.provider}
                    onValueChange={(value) => setForm((prev) => ({ ...prev, provider: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Provider (Department/College)" />
                    </SelectTrigger>
                    <SelectContent>
                      {providerOptions.length > 0 ? (
                        providerOptions.map((providerName) => (
                          <SelectItem key={providerName} value={providerName}>
                            {providerName}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="__no_provider_options__" disabled>
                          No department/college options available
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                )}
                <Input
                  placeholder="Venue"
                  value={form.venue}
                  onChange={(event) => setForm((prev) => ({ ...prev, venue: event.target.value }))}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    type="date"
                    value={form.startDate}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, startDate: event.target.value }))
                    }
                  />
                  <Input
                    type="date"
                    value={form.endDate}
                    onChange={(event) => setForm((prev) => ({ ...prev, endDate: event.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Hours Credit</label>
                  <Input
                    type="number"
                    value={form.hours}
                    onChange={(event) => setForm((prev) => ({ ...prev, hours: event.target.value }))}
                  />
                </div>
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
                <Button onClick={handleCreateOrUpdate}>
                  {editingEventId ? "Save Changes" : "Create Training/Workshop"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        ) : null}
      </div>

      <div className="flex items-center gap-4 overflow-x-auto pb-2">
        {["All", "Drafts", "Submitted", "Approved", "Locked"].map((value) => (
          <Button
            key={value}
            variant={filter === value ? "default" : "outline"}
            onClick={() => setFilter(value)}
            className="rounded-full"
            size="sm"
          >
            {value}
          </Button>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map((event: any) => {
          const canEdit = event.workflowStatus === "draft" || event.workflowStatus === "returned";
          return (
            <Card key={event.id} className="group border-border/60 transition-all hover:shadow-lg">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <Badge variant="outline" className="mb-2 w-fit border-primary/20 bg-primary/5 text-primary">
                    {formatCategoryLabel(event.category) || event.deliveryMode}
                  </Badge>
                  {canCreate ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="-mr-2 -mt-2 h-8 w-8 text-muted-foreground">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {canEdit ? (
                          <DropdownMenuItem onClick={() => openEditDialog(event)}>
                            Edit Details
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem onClick={() => copyAsTemplate(event)}>
                          <Copy className="mr-2 h-4 w-4" />
                          Copy as Template
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => {
                            setArchiveTargetEvent(event);
                            setArchiveReason("");
                            setArchiveDialogOpen(true);
                          }}
                        >
                          Archive Event
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                <CardTitle className="h-12 line-clamp-2 leading-tight">{event.title}</CardTitle>
                <CardDescription className="mt-1 flex items-center">
                  <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                  {new Date(event.startDate).toLocaleDateString("en-US", {
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
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
                    {event.provider || (normalizeCategory(event.category) === "internal" ? "Internal" : "-")}
                  </div>
                </div>
              </CardContent>
              <CardFooter className="border-t bg-muted/20 pt-2">
                <div className="flex w-full items-center justify-between">
                  <Badge variant="outline">{event.workflowStatus}</Badge>
                  <div className="flex items-center gap-2">
                    {canSubmit && (event.workflowStatus === "draft" || event.workflowStatus === "returned") ? (
                      <Button variant="outline" size="sm" onClick={() => handleSubmit(event.id)}>
                        Submit
                      </Button>
                    ) : null}
                    <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setDetailsEvent(event)}>
                      View Details
                    </Button>
                  </div>
                </div>
              </CardFooter>
            </Card>
          );
        })}
      </div>

      <Dialog open={Boolean(detailsEvent)} onOpenChange={() => setDetailsEvent(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{detailsEvent?.title || "Training Event"}</DialogTitle>
            <DialogDescription className="sr-only">
              Training event details.
            </DialogDescription>
          </DialogHeader>
          {detailsEvent ? (
            <div className="space-y-3 text-sm">
              <div className="rounded-md border bg-muted/20 p-3">
                <div>
                  <span className="font-medium">Date:</span> {detailsEvent.startDate} to {detailsEvent.endDate}
                </div>
                <div>
                  <span className="font-medium">Delivery:</span> {detailsEvent.deliveryMode}
                </div>
                <div>
                  <span className="font-medium">Visibility:</span> {detailsEvent.visibilityScope}
                </div>
                <div>
                  <span className="font-medium">Mandatory:</span>{" "}
                  {detailsEvent.isMandatory ? "Yes" : "No"}
                </div>
                <div>
                  <span className="font-medium">Provider:</span>{" "}
                  {detailsEvent.provider ||
                    (normalizeCategory(detailsEvent.category) === "internal" ? "Internal" : "-")}
                </div>
                <div>
                  <span className="font-medium">Venue:</span> {detailsEvent.venue || "-"}
                </div>
                <div>
                  <span className="font-medium">Hours:</span> {detailsEvent.hours}
                </div>
              </div>
              {detailsEvent.description ? (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Description
                  </div>
                  <p className="mt-1">{detailsEvent.description}</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={archiveDialogOpen}
        onOpenChange={(open) => {
          setArchiveDialogOpen(open);
          if (!open) {
            setArchiveTargetEvent(null);
            setArchiveReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive Training Event</DialogTitle>
            <DialogDescription>
              Provide a reason before archiving {archiveTargetEvent?.title || "this event"}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              placeholder="Reason for archive"
              value={archiveReason}
              onChange={(event) => setArchiveReason(event.target.value)}
            />
            <Button
              variant="destructive"
              disabled={archiveReason.trim().length < 3}
              onClick={handleArchive}
            >
              Archive
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
