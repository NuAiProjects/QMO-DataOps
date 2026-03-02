import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, getQueryFn, queryClient } from "@/lib/queryClient";
import { useUser } from "@/hooks/use-user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoadingState } from "@/components/ui/loading-state";
import { Plus } from "lucide-react";

type Role =
  | "super_admin"
  | "hr_qa_approver"
  | "unit_head"
  | "encoder"
  | "viewer_auditor";

type UserRow = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  unitIds: string[];
  hasPassword?: boolean;
};

type UnitRow = {
  id: string;
  name: string;
};

const roleOptions: Array<{ label: string; value: Role }> = [
  { label: "Super Admin", value: "super_admin" },
  { label: "HR/QA Approver", value: "hr_qa_approver" },
  { label: "Unit Head", value: "unit_head" },
  { label: "Encoder", value: "encoder" },
  { label: "Viewer/Auditor", value: "viewer_auditor" },
];

const defaultForm = {
  email: "",
  fullName: "",
  role: "encoder" as Role,
  isActive: true,
  unitIds: [] as string[],
};

const MIN_PASSWORD_LENGTH = 10;

function parseApiError(error: unknown) {
  const raw = error instanceof Error ? error.message.replace(/^Error:\s*/, "") : "Request failed.";
  const jsonMatch = raw.match(/\{.*\}$/);
  if (!jsonMatch) return raw;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { message?: string };
    return parsed.message || raw;
  } catch {
    return raw;
  }
}

export default function Users() {
  const { user } = useUser();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordTargetUserId, setPasswordTargetUserId] = useState<string | null>(null);
  const [passwordTargetName, setPasswordTargetName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [myNewPassword, setMyNewPassword] = useState("");
  const [form, setForm] = useState(defaultForm);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const canManageUsers = user?.role === "super_admin";
  const isSetPasswordValid = newPassword.length >= MIN_PASSWORD_LENGTH;
  const isMyNewPasswordValid = myNewPassword.length >= MIN_PASSWORD_LENGTH;
  const canSubmitChangeMyPassword = currentPassword.length > 0 && isMyNewPasswordValid;

  const { data, isLoading: usersLoading } = useQuery<{ users: UserRow[] }>({
    queryKey: ["/api/users"],
    queryFn: getQueryFn({ on401: "throw" }),
  });
  const { data: unitsData, isLoading: unitsLoading } = useQuery<{ units: UnitRow[] }>({
    queryKey: ["/api/units"],
    queryFn: getQueryFn({ on401: "throw" }),
  });

  const rows = data?.users ?? [];
  const units = unitsData?.units ?? [];
  const unitNameById = useMemo(() => {
    return new Map(units.map((unit) => [unit.id, unit.name]));
  }, [units]);

  if (usersLoading || unitsLoading) {
    return <LoadingState label="Loading users..." className="min-h-[420px]" />;
  }

  const openCreate = () => {
    setEditingUserId(null);
    setErrorMessage(null);
    setForm(defaultForm);
    setDialogOpen(true);
  };

  const openEdit = (target: UserRow) => {
    setEditingUserId(target.id);
    setErrorMessage(null);
    setForm({
      email: target.email,
      fullName: target.fullName,
      role: target.role,
      isActive: target.isActive,
      unitIds: [...target.unitIds],
    });
    setDialogOpen(true);
  };

  const submitForm = async () => {
    setErrorMessage(null);
    try {
      const payload = {
        email: form.email.trim(),
        fullName: form.fullName.trim(),
        role: form.role,
        isActive: form.isActive,
        unitIds: form.unitIds,
      };

      if (editingUserId) {
        await apiRequest("PUT", `/api/users/${editingUserId}`, payload);
      } else {
        await apiRequest("POST", "/api/users", payload);
      }
      await queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setDialogOpen(false);
    } catch (error) {
      setErrorMessage(parseApiError(error));
    }
  };

  const openSetPasswordDialog = (target: UserRow) => {
    setPasswordTargetUserId(target.id);
    setPasswordTargetName(target.fullName);
    setNewPassword("");
    setErrorMessage(null);
    setPasswordDialogOpen(true);
  };

  const handleSetPasswordDialogOpenChange = (open: boolean) => {
    setPasswordDialogOpen(open);
    if (!open) {
      setNewPassword("");
      setErrorMessage(null);
    }
  };

  const handleChangePasswordDialogOpenChange = (open: boolean) => {
    setChangePasswordOpen(open);
    if (!open) {
      setCurrentPassword("");
      setMyNewPassword("");
    }
    setErrorMessage(null);
  };

  const submitSetPassword = async () => {
    if (!passwordTargetUserId) return;
    setErrorMessage(null);
    try {
      await apiRequest("POST", `/api/users/${passwordTargetUserId}/password`, {
        password: newPassword,
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setPasswordDialogOpen(false);
      setNewPassword("");
    } catch (error) {
      setErrorMessage(parseApiError(error));
    }
  };

  const submitChangeMyPassword = async () => {
    setErrorMessage(null);
    try {
      await apiRequest("POST", "/api/auth/change-password", {
        currentPassword,
        newPassword: myNewPassword,
      });
      setChangePasswordOpen(false);
      setCurrentPassword("");
      setMyNewPassword("");
    } catch (error) {
      setErrorMessage(parseApiError(error));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-display font-bold">Users & Roles</h1>
          <p className="text-muted-foreground">
            Manage application users, permissions, and unit assignments.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Dialog open={changePasswordOpen} onOpenChange={handleChangePasswordDialogOpenChange}>
            <DialogTrigger asChild>
              <Button variant="outline">Change My Password</Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Change Password</DialogTitle>
                <DialogDescription>Update your login password.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {errorMessage ? (
                  <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {errorMessage}
                  </div>
                ) : null}
                <Input
                  type="password"
                  placeholder="Current password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
                <Input
                  type="password"
                  placeholder={`New password (min ${MIN_PASSWORD_LENGTH} characters)`}
                  value={myNewPassword}
                  onChange={(event) => setMyNewPassword(event.target.value)}
                />
                <p
                  className={`text-xs ${
                    isMyNewPasswordValid ? "text-emerald-600" : "text-muted-foreground"
                  }`}
                >
                  {isMyNewPasswordValid
                    ? "Password length is valid."
                    : `Use at least ${MIN_PASSWORD_LENGTH} characters.`}
                </p>
                <Button onClick={submitChangeMyPassword} disabled={!canSubmitChangeMyPassword}>
                  Update Password
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        {canManageUsers ? (
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" />
                New User
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-xl">
              <DialogHeader>
                <DialogTitle>{editingUserId ? "Edit User" : "Create User"}</DialogTitle>
                <DialogDescription className="sr-only">
                  Configure user profile and role assignments.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {errorMessage ? (
                  <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {errorMessage}
                  </div>
                ) : null}
                <Input
                  placeholder="Email"
                  value={form.email}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, email: event.target.value }))
                  }
                />
                <Input
                  placeholder="Full name"
                  value={form.fullName}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, fullName: event.target.value }))
                  }
                />
                <Select
                  value={form.role}
                  onValueChange={(value) =>
                    setForm((prev) => ({ ...prev, role: value as Role }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    {roleOptions.map((role) => (
                      <SelectItem key={role.value} value={role.value}>
                        {role.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2 rounded-md border p-3">
                  <Checkbox
                    id="is-active"
                    checked={form.isActive}
                    onCheckedChange={(checked) =>
                      setForm((prev) => ({ ...prev, isActive: checked === true }))
                    }
                  />
                  <label htmlFor="is-active" className="text-sm font-medium">
                    Active user
                  </label>
                </div>
                <div className="space-y-2 rounded-md border p-3">
                  <div className="text-sm font-medium">Assigned units</div>
                  <div className="grid max-h-40 grid-cols-1 gap-2 overflow-y-auto">
                    {units.map((unit) => {
                      const checked = form.unitIds.includes(unit.id);
                      return (
                        <label key={unit.id} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(isChecked) =>
                              setForm((prev) => ({
                                ...prev,
                                unitIds: isChecked
                                  ? [...prev.unitIds, unit.id]
                                  : prev.unitIds.filter((value) => value !== unit.id),
                              }))
                            }
                          />
                          <span>{unit.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <Button onClick={submitForm}>{editingUserId ? "Save Changes" : "Create User"}</Button>
              </div>
            </DialogContent>
          </Dialog>
        ) : null}
        </div>
      </div>

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle>Directory</CardTitle>
          <CardDescription>Current application users and role coverage.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Password</TableHead>
                <TableHead>Units</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.fullName}</TableCell>
                  <TableCell>{row.email}</TableCell>
                  <TableCell>
                    {roleOptions.find((role) => role.value === row.role)?.label || row.role}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{row.isActive ? "Active" : "Inactive"}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{row.hasPassword ? "Configured" : "Not set"}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-[280px] truncate text-sm text-muted-foreground">
                      {row.unitIds.map((unitId) => unitNameById.get(unitId) || unitId).join(", ") ||
                        "-"}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {canManageUsers ? (
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
                          Edit
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => openSetPasswordDialog(row)}>
                          Set Password
                        </Button>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={passwordDialogOpen} onOpenChange={handleSetPasswordDialogOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Set User Password</DialogTitle>
            <DialogDescription>
              Set a login password for {passwordTargetName || "this user"}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {errorMessage ? (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errorMessage}
              </div>
            ) : null}
            <Input
              type="password"
              placeholder={`New password (min ${MIN_PASSWORD_LENGTH} characters)`}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
            <p
              className={`text-xs ${
                isSetPasswordValid ? "text-emerald-600" : "text-muted-foreground"
              }`}
            >
              {isSetPasswordValid
                ? "Password length is valid."
                : `Use at least ${MIN_PASSWORD_LENGTH} characters.`}
            </p>
            <Button onClick={submitSetPassword} disabled={!isSetPasswordValid}>
              Save Password
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
