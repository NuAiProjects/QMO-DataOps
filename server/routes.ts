import type { Express } from "express";
import express from "express";
import { type Server } from "http";
import path from "path";
import fs from "fs/promises";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { and, asc, desc, eq, ilike, inArray, or, sql, gte, lte } from "drizzle-orm";
import { z } from "zod";
import {
  configureAuth,
  getUserIdsWithPasswordCredentials,
  setUserPasswordCredential,
  verifyUserPasswordCredential,
} from "./auth";
import { db } from "./db";
import {
  attachments,
  auditLogs,
  attendanceImportBatches,
  attendanceImportRows,
  attendanceRecords,
  employees,
  trainingEvents,
  units,
  userUnits,
  users,
} from "@shared/schema";
import { requireAnyRoleOrSuperAdmin, requireAuth, requireRole } from "./middleware/auth";
import { getScopedUnitIds, getUnitsInScopeForUser } from "./scope";
import { logAudit, logWorkflowAction } from "./audit";

const uploadRoot = path.resolve("uploads");

async function ensureUploadsDir() {
  await fs.mkdir(uploadRoot, { recursive: true });
}

const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      await ensureUploadsDir();
      cb(null, uploadRoot);
    },
    filename: (_req, file, cb) => {
      const timestamp = Date.now();
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${timestamp}-${safeName}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/pdf", "image/jpeg", "image/png"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only PDF, JPG, and PNG files are allowed."));
    }
    cb(null, true);
  },
});

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["text/csv", "application/vnd.ms-excel"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only CSV files are allowed."));
    }
    cb(null, true);
  },
});

const unitInputSchema = z.object({
  name: z.string().min(1),
  code: z.string().trim().optional().nullable(),
  parentUnitId: z.string().uuid().optional().nullable(),
});

const userInputSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(1),
  role: z.enum([
    "super_admin",
    "hr_qa_approver",
    "unit_head",
    "encoder",
    "viewer_auditor",
  ]),
  isActive: z.boolean().optional(),
  unitIds: z.array(z.string().uuid()).optional(),
});

const employeeInputSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  unitId: z.string().uuid(),
  position: z.string().optional().nullable(),
  employmentStatus: z.enum(["active", "inactive"]).optional(),
  hireDate: z.string().optional().nullable(),
});

const trainingEventInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  deliveryMode: z.enum(["in_person", "virtual", "hybrid", "self_paced"]),
  provider: z.string().optional().nullable(),
  venue: z.string().optional().nullable(),
  startDate: z.string().min(1, "Start date is required."),
  endDate: z.string().min(1, "End date is required."),
  hours: z.union([z.number(), z.string().min(1, "Hours is required.")]),
  ownerUnitId: z.string().uuid(),
  visibilityScope: z.enum(["unit", "department", "org"]).optional(),
  isMandatory: z.boolean().optional(),
});

const attendanceInputSchema = z.object({
  trainingEventId: z.string().uuid(),
  employeeId: z.string().uuid(),
  attendanceDate: z.string().min(1, "Attendance date is required."),
  hoursCredited: z.union([z.number(), z.string().min(1, "Hours credited is required.")]),
  attendanceStatus: z.enum(["present", "absent", "partial"]).optional(),
});

const returnSchema = z.object({
  notes: z.string().min(1),
});

const softDeleteSchema = z.object({
  reason: z.string().trim().min(3, "Delete reason is required."),
});

const setPasswordSchema = z.object({
  password: z.string().trim().min(10, "Password must be at least 10 characters."),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().trim().min(1, "Current password is required."),
  newPassword: z.string().trim().min(10, "New password must be at least 10 characters."),
});

const resolveRowsSchema = z.object({
  resolutions: z.array(
    z.object({
      rowId: z.string().uuid(),
      employeeId: z.string().uuid().optional(),
      markInvalid: z.boolean().optional(),
    }),
  ),
});

const commitImportSchema = z.object({
  decisions: z
    .array(
      z.object({
        rowId: z.string().uuid(),
        action: z.enum(["skip", "update"]),
      }),
    )
    .optional(),
});

const requiredAttendanceCsvHeaders = ["Email", "Participants", "Date", "Title"] as const;
const requiredEmployeeCsvHeaders = [
  "No.",
  "NU Email",
  "Full Name (Last Name, First Name Middle Name)",
  "ASP/Official/Faculty",
  "Department/College",
  "Division",
] as const;
const malformedNuEmployeeCsvHeaders = [
  "No.",
  "NU Email",
  "Full Name (Last Name",
  "First Name Middle Name)",
  "ASP/Official/Faculty",
  "Department/College",
] as const;
const legacyRequiredEmployeeCsvHeaders = [
  "Email",
  "Full Name",
  "Department",
  "Position",
  "Employment Status",
] as const;

function normalizeCsvText(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeLooseCsvText(value: string | null | undefined) {
  return normalizeCsvText(value).replace(/[^a-z0-9]/g, "");
}

function normalizeAttendanceTitleKey(value: string | null | undefined) {
  const normalized = normalizeCsvText(value).replace(/^(the|a|an)\s+/, "");
  return normalized.replace(/[^a-z0-9]/g, "");
}

function getCsvRowValue(row: Record<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") {
      return value.trim();
    }
  }
  return "";
}

function getRouteParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function buildNameUnitKey(fullName: string, unitId: string) {
  return `${normalizeCsvText(fullName)}::${normalizeCsvText(unitId)}`;
}

function toIsoDate(year: number, month: number, day: number) {
  const normalizedYear = year.toString().padStart(4, "0");
  const normalizedMonth = month.toString().padStart(2, "0");
  const normalizedDay = day.toString().padStart(2, "0");
  const iso = `${normalizedYear}-${normalizedMonth}-${normalizedDay}`;
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return iso;
}

function isIsoDateString(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isStartDateAfterEndDate(startDate: string, endDate: string) {
  if (!isIsoDateString(startDate) || !isIsoDateString(endDate)) {
    return false;
  }
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return false;
  }
  return start > end;
}

function isImportableTrainingEventStatus(status: string) {
  return status === "draft" || status === "returned" || status === "approved";
}

function normalizeAttendanceCsvDate(input: string | null | undefined) {
  const value = (input ?? "").trim();
  if (!value) return null;

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (isoMatch) {
    return toIsoDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  if (slashMatch) {
    const rawYear = Number(slashMatch[3]);
    const year = slashMatch[3].length === 2 ? 2000 + rawYear : rawYear;
    return toIsoDate(year, Number(slashMatch[1]), Number(slashMatch[2]));
  }

  const dashMatch = /^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/.exec(value);
  if (dashMatch) {
    const rawYear = Number(dashMatch[3]);
    const year = dashMatch[3].length === 2 ? 2000 + rawYear : rawYear;
    return toIsoDate(year, Number(dashMatch[1]), Number(dashMatch[2]));
  }

  const textMonthMatch = /^(\d{1,2})-([a-zA-Z]{3,9})-(\d{2}|\d{4})$/.exec(value);
  if (textMonthMatch) {
    const monthKey = textMonthMatch[2].toLowerCase().slice(0, 3);
    const monthMap: Record<string, number> = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12,
    };
    const month = monthMap[monthKey];
    if (!month) return null;
    const rawYear = Number(textMonthMatch[3]);
    const year = textMonthMatch[3].length === 2 ? 2000 + rawYear : rawYear;
    return toIsoDate(year, month, Number(textMonthMatch[1]));
  }

  return null;
}

function parseAttendanceCsvDates(input: string | null | undefined) {
  const value = (input ?? "").trim();
  if (!value) {
    return {
      dates: [] as string[],
      error: "Date is required.",
    };
  }

  const collapsedValue = value.replace(/\s+/g, " ").trim();
  const rangeMatch =
    /^(.+?)\s+(?:to)\s+(.+)$/i.exec(collapsedValue) ||
    /^(.+?)\s*(?:-|–|—)\s*(.+)$/.exec(collapsedValue);
  if (rangeMatch) {
    const startIso = normalizeAttendanceCsvDate(rangeMatch[1]);
    const endIso = normalizeAttendanceCsvDate(rangeMatch[2]);
    if (!startIso || !endIso) {
      return {
        dates: [] as string[],
        error:
          "Date range must use valid start and end dates (e.g., 2025-10-29 to 2025-12-17).",
      };
    }
    const start = new Date(`${startIso}T00:00:00.000Z`);
    const end = new Date(`${endIso}T00:00:00.000Z`);
    if (start.getTime() > end.getTime()) {
      return {
        dates: [] as string[],
        error: "Date range start must be on or before the end date.",
      };
    }

    const diffDays = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
    const useWeeklyStep = diffDays >= 7 && start.getUTCDay() === end.getUTCDay();
    const stepDays = useWeeklyStep ? 7 : 1;
    const dates: string[] = [];
    const cursor = new Date(start);
    while (cursor.getTime() <= end.getTime()) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + stepDays);
    }
    return { dates };
  }

  const splitValues = value
    .split(/[;,]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const sourceValues = splitValues.length > 0 ? splitValues : [value];
  const parsedDates: string[] = [];
  for (const candidate of sourceValues) {
    const parsed = normalizeAttendanceCsvDate(candidate);
    if (!parsed) {
      return {
        dates: [] as string[],
        error:
          "Date must be in YYYY-MM-DD, MM/DD/YYYY, MM/DD/YY, or DD-MMM-YY format. Ranges may use 'to'.",
      };
    }
    parsedDates.push(parsed);
  }

  return {
    dates: Array.from(new Set(parsedDates)).sort(),
  };
}

function isEditableStatus(status: string) {
  return status === "draft" || status === "returned";
}

function isSubmittedStatus(status: string) {
  return status === "submitted";
}

function employeeNotDeletedCondition() {
  return sql`${employees.deletedAt} is null`;
}

function trainingEventNotDeletedCondition() {
  return sql`${trainingEvents.deletedAt} is null`;
}

function attendanceNotDeletedCondition() {
  return sql`${attendanceRecords.deletedAt} is null`;
}

async function isEntityInScope(
  entityType: "attendance_record" | "training_event" | "employee",
  entityId: string,
  scopeUnitIds: string[],
) {
  if (entityType === "training_event") {
    const [row] = await db
      .select({ ownerUnitId: trainingEvents.ownerUnitId })
      .from(trainingEvents)
      .where(and(eq(trainingEvents.id, entityId), trainingEventNotDeletedCondition()))
      .limit(1);
    return !!row && scopeUnitIds.includes(row.ownerUnitId);
  }
  if (entityType === "employee") {
    const [row] = await db
      .select({ unitId: employees.unitId })
      .from(employees)
      .where(and(eq(employees.id, entityId), employeeNotDeletedCondition()))
      .limit(1);
    return !!row && scopeUnitIds.includes(row.unitId);
  }
  const [attendanceRow] = await db
    .select({ employeeId: attendanceRecords.employeeId })
    .from(attendanceRecords)
    .where(and(eq(attendanceRecords.id, entityId), attendanceNotDeletedCondition()))
    .limit(1);
  if (!attendanceRow) return false;
  const [employeeRow] = await db
    .select({ unitId: employees.unitId })
    .from(employees)
    .where(and(eq(employees.id, attendanceRow.employeeId), employeeNotDeletedCondition()))
    .limit(1);
  return !!employeeRow && scopeUnitIds.includes(employeeRow.unitId);
}

async function canUserViewAuditLog(
  row: typeof auditLogs.$inferSelect,
  user: Express.User,
  scopeUnitIds: string[],
) {
  if (user.role === "super_admin" || user.role === "hr_qa_approver") {
    return true;
  }
  if (row.actorUserId && row.actorUserId === user.id) {
    return true;
  }
  if (!row.entityId) {
    return false;
  }
  if (
    row.entityType === "attendance_record" ||
    row.entityType === "training_event" ||
    row.entityType === "employee"
  ) {
    return isEntityInScope(row.entityType, row.entityId, scopeUnitIds);
  }
  return false;
}

async function getDescendantUnits(
  rootUnitId: string,
  scopeUnitIds: string[],
) {
  const scopedUnits = await db
    .select({ id: units.id, parentUnitId: units.parentUnitId })
    .from(units)
    .where(inArray(units.id, scopeUnitIds));
  const childrenMap = new Map<string, string[]>();
  for (const unit of scopedUnits) {
    if (!unit.parentUnitId) continue;
    const list = childrenMap.get(unit.parentUnitId) || [];
    list.push(unit.id);
    childrenMap.set(unit.parentUnitId, list);
  }
  const result = new Set<string>();
  const stack = [rootUnitId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || result.has(current)) continue;
    result.add(current);
    const children = childrenMap.get(current) || [];
    for (const child of children) stack.push(child);
  }
  return Array.from(result);
}

async function getUnitParentMap() {
  const rows = await db
    .select({ id: units.id, parentUnitId: units.parentUnitId })
    .from(units);
  const map = new Map<string, string | null>();
  for (const row of rows) {
    map.set(row.id, row.parentUnitId ?? null);
  }
  return map;
}

function getRootUnitId(
  unitId: string,
  parentMap: Map<string, string | null>,
) {
  let current: string | null | undefined = unitId;
  let guard = 0;
  while (current && guard < 1024) {
    const parent = parentMap.get(current);
    if (!parent) return current;
    current = parent;
    guard += 1;
  }
  return unitId;
}

function isSameOrDescendantUnit(
  candidateUnitId: string,
  ancestorUnitId: string,
  parentMap: Map<string, string | null>,
) {
  let current: string | null | undefined = candidateUnitId;
  let guard = 0;
  while (current && guard < 1024) {
    if (current === ancestorUnitId) {
      return true;
    }
    current = parentMap.get(current) ?? null;
    guard += 1;
  }
  return false;
}

function isTrainingEventVisibleToUnit(
  event: { ownerUnitId: string; visibilityScope: string | null | undefined },
  unitId: string,
  parentMap: Map<string, string | null>,
) {
  const visibilityScope = event.visibilityScope || "unit";
  if (visibilityScope === "org") {
    return true;
  }
  if (visibilityScope === "department") {
    return (
      getRootUnitId(event.ownerUnitId, parentMap) ===
      getRootUnitId(unitId, parentMap)
    );
  }
  return isSameOrDescendantUnit(unitId, event.ownerUnitId, parentMap);
}

function isTrainingEventVisibleToScope(
  event: { ownerUnitId: string; visibilityScope: string | null | undefined },
  unitIds: string[],
  parentMap: Map<string, string | null>,
) {
  return unitIds.some((unitId) =>
    isTrainingEventVisibleToUnit(event, unitId, parentMap),
  );
}

const reportQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  unitId: z.string().uuid().optional(),
  includeChildren: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  format: z.enum(["csv"]).optional(),
});
const REPORT_PAGE_SIZE = 20;

const dashboardActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const searchQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
});

function toIsoTimestamp(value: Date | string | null | undefined) {
  if (!value) return new Date(0).toISOString();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date(0).toISOString();
  return date.toISOString();
}

function buildPathWithQuery(
  pathname: string,
  params: Record<string, string | null | undefined>,
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.trim().length > 0) {
      search.set(key, value);
    }
  }
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function isRecentlyCreated(
  createdAt: Date | string | null | undefined,
  updatedAt: Date | string | null | undefined,
) {
  if (!createdAt || !updatedAt) return false;
  const created = new Date(createdAt).getTime();
  const updated = new Date(updatedAt).getTime();
  if (Number.isNaN(created) || Number.isNaN(updated)) return false;
  return Math.abs(updated - created) < 60_000;
}

function toCsv<T extends Record<string, any>>(rows: T[]) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((key) => escape(row[key])).join(",")),
  ];
  return lines.join("\n");
}

function paginateReportRows<T>(rows: T[], page: number) {
  const total = rows.length;
  const totalPages = total === 0 ? 1 : Math.ceil(total / REPORT_PAGE_SIZE);
  const currentPage = Math.min(Math.max(page, 1), totalPages);
  const startIndex = (currentPage - 1) * REPORT_PAGE_SIZE;
  const pagedRows = rows.slice(startIndex, startIndex + REPORT_PAGE_SIZE);

  return {
    rows: pagedRows,
    pagination: {
      page: currentPage,
      pageSize: REPORT_PAGE_SIZE,
      total,
      totalPages,
    },
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  await configureAuth(app);

  const api = express.Router();
  api.use(requireAuth);

  api.get("/units", async (req, res) => {
    const scopeUnits = await getUnitsInScopeForUser(req.user!);
    res.json({ units: scopeUnits });
  });

  api.post("/units", requireRole(["super_admin"]), async (req, res) => {
    const parsed = unitInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const [unit] = await db.insert(units).values(parsed.data).returning();
    await logAudit({
      actorUserId: req.user!.id,
      action: "unit.create",
      entityType: "unit",
      entityId: unit.id,
      afterJson: unit,
      ip: req.ip,
    });
    res.status(201).json({ unit });
  });

  api.put("/units/:id", requireRole(["super_admin"]), async (req, res) => {
    const parsed = unitInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const unitId = getRouteParam(req.params.id);
    const [existing] = await db
      .select()
      .from(units)
      .where(eq(units.id, unitId))
      .limit(1);
    if (!existing) {
      return res.status(404).json({ message: "Unit not found." });
    }
    const [updated] = await db
      .update(units)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(units.id, unitId))
      .returning();
    await logAudit({
      actorUserId: req.user!.id,
      action: "unit.update",
      entityType: "unit",
      entityId: unitId,
      beforeJson: existing,
      afterJson: updated,
      ip: req.ip,
    });
    res.json({ unit: updated });
  });

  api.get(
    "/users",
    requireRole(["super_admin"]),
    async (req, res) => {
      const rows = await db.select().from(users).orderBy(asc(users.fullName));
      const userUnitRows = await db.select().from(userUnits);
      const usersWithPassword = await getUserIdsWithPasswordCredentials(
        rows.map((row) => row.id),
      );
      const unitMap = userUnitRows.reduce<Record<string, string[]>>((acc, row) => {
        acc[row.userId] = acc[row.userId] || [];
        acc[row.userId].push(row.unitId);
        return acc;
      }, {});

      res.json({
        users: rows.map((user) => ({
          ...user,
          unitIds: unitMap[user.id] || [],
          hasPassword: usersWithPassword.has(user.id),
        })),
      });
    },
  );

  api.post("/users", requireRole(["super_admin"]), async (req, res) => {
    const parsed = userInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const { unitIds = [], ...data } = parsed.data;
    const [created] = await db
      .insert(users)
      .values({ ...data, isActive: data.isActive ?? true })
      .returning();
    if (unitIds.length > 0) {
      await db
        .insert(userUnits)
        .values(unitIds.map((unitId) => ({ userId: created.id, unitId })));
    }
    await logAudit({
      actorUserId: req.user!.id,
      action: "user.create",
      entityType: "user",
      entityId: created.id,
      afterJson: { ...created, unitIds },
      ip: req.ip,
    });
    res.status(201).json({ user: created });
  });

  api.put("/users/:id", requireRole(["super_admin"]), async (req, res) => {
    const parsed = userInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const userId = getRouteParam(req.params.id);
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!existing) {
      return res.status(404).json({ message: "User not found." });
    }
    const { unitIds = [], ...data } = parsed.data;
    const [updated] = await db
      .update(users)
      .set({
        ...data,
        isActive: data.isActive ?? existing.isActive,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();
    await db.delete(userUnits).where(eq(userUnits.userId, userId));
    if (unitIds.length > 0) {
      await db
        .insert(userUnits)
        .values(unitIds.map((unitId) => ({ userId, unitId })));
    }
    await logAudit({
      actorUserId: req.user!.id,
      action: "user.update",
      entityType: "user",
      entityId: userId,
      beforeJson: existing,
      afterJson: { ...updated, unitIds },
      ip: req.ip,
    });
    res.json({ user: updated });
  });

  api.post("/users/:id/password", requireRole(["super_admin"]), async (req, res) => {
    const parsed = setPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const userId = getRouteParam(req.params.id);
    const [target] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!target) {
      return res.status(404).json({ message: "User not found." });
    }

    await setUserPasswordCredential({
      userId,
      plainPassword: parsed.data.password,
      updatedByUserId: req.user!.id,
    });
    await logAudit({
      actorUserId: req.user!.id,
      action: "user.password.set",
      entityType: "user",
      entityId: userId,
      ip: req.ip,
    });
    res.json({ ok: true });
  });

  api.post("/auth/change-password", async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }

    const isCurrentPasswordValid = await verifyUserPasswordCredential(
      req.user!.id,
      parsed.data.currentPassword,
    );
    if (!isCurrentPasswordValid) {
      return res.status(401).json({ message: "Current password is incorrect." });
    }

    await setUserPasswordCredential({
      userId: req.user!.id,
      plainPassword: parsed.data.newPassword,
      updatedByUserId: req.user!.id,
    });
    await logAudit({
      actorUserId: req.user!.id,
      action: "auth.password.change",
      entityType: "auth_session",
      entityId: null,
      ip: req.ip,
    });
    res.json({ ok: true });
  });

  api.get("/employees", async (req, res) => {
    const scopeUnitIds = await getScopedUnitIds(req.user!);
    if (scopeUnitIds.length === 0) {
      return res.json({ employees: [] });
    }
    const querySchema = z.object({
      unitId: z.string().uuid().optional(),
      includeChildren: z.string().optional(),
      q: z.string().optional(),
      status: z.enum(["active", "inactive"]).optional(),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }

    const { unitId, includeChildren, q, status } = parsed.data;
    let allowedUnits = scopeUnitIds;
    if (unitId) {
      if (!scopeUnitIds.includes(unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      allowedUnits =
        includeChildren === "true"
          ? await getDescendantUnits(unitId, scopeUnitIds)
          : [unitId];
    }

    const filters = [inArray(employees.unitId, allowedUnits), employeeNotDeletedCondition()];
    if (q) {
      filters.push(
        or(
          ilike(employees.fullName, `%${q}%`),
          ilike(employees.employeeNo, `%${q}%`),
        )!,
      );
    }
    if (status) {
      filters.push(eq(employees.employmentStatus, status));
    }

    const rows = await db
      .select()
      .from(employees)
      .where(and(...filters))
      .orderBy(asc(employees.fullName));
    res.json({ employees: rows });
  });

  api.post(
    "/employees",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = employeeInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(parsed.data.unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      const normalizedEmail = parsed.data.email.trim().toLowerCase();
      const [emailInUse] = await db
        .select({ id: employees.id })
        .from(employees)
        .where(and(ilike(employees.email, normalizedEmail), employeeNotDeletedCondition()))
        .limit(1);
      if (emailInUse) {
        return res.status(409).json({ message: "An employee with this email already exists." });
      }
      const [created] = await db
        .insert(employees)
        .values({
          employeeNo: normalizedEmail,
          ...parsed.data,
          email: normalizedEmail,
          employmentStatus: parsed.data.employmentStatus ?? "active",
        })
        .returning();
      await logAudit({
        actorUserId: req.user!.id,
        action: "employee.create",
        entityType: "employee",
        entityId: created.id,
        afterJson: created,
        ip: req.ip,
      });
      res.status(201).json({ employee: created });
    },
  );

  api.post(
    "/employees/import",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    csvUpload.single("file"),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ message: "CSV file is required." });
      }

      const rawCsv = req.file.buffer.toString("utf-8");
      let parsedHeaders: string[] = [];
      let records: Record<string, string>[] = [];
      try {
        records = parse(rawCsv, {
          columns: (headers: string[]) => {
            parsedHeaders = headers.map((header) => header.trim());
            return parsedHeaders;
          },
          skip_empty_lines: true,
          trim: true,
          bom: true,
          relax_column_count: true,
        }) as Record<string, string>[];
      } catch {
        return res.status(400).json({ message: "Invalid CSV format." });
      }

      const hasNuTemplateHeaders = requiredEmployeeCsvHeaders.every((header) =>
        parsedHeaders.includes(header),
      );
      const hasMalformedNuHeaders = malformedNuEmployeeCsvHeaders.every((header) =>
        parsedHeaders.includes(header),
      );
      const hasLegacyHeaders = legacyRequiredEmployeeCsvHeaders.every((header) =>
        parsedHeaders.includes(header),
      );
      const useMalformedNuMapping = hasMalformedNuHeaders && !hasNuTemplateHeaders;
      if (!hasNuTemplateHeaders && !hasMalformedNuHeaders && !hasLegacyHeaders) {
        return res.status(400).json({
          message:
            "Invalid CSV schema. Required columns are either NU template (No., NU Email, Full Name (Last Name, First Name Middle Name), ASP/Official/Faculty, Department/College, Division), malformed NU header variant, or legacy template (Email, Full Name, Department, Position, Employment Status).",
        });
      }

      if (records.length === 0) {
        return res.status(400).json({ message: "CSV has no data rows." });
      }

      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (scopeUnitIds.length === 0) {
        return res.status(403).json({ message: "No units in scope." });
      }

      const scopedUnits = await db
        .select({
          id: units.id,
          name: units.name,
          code: units.code,
        })
        .from(units)
        .where(inArray(units.id, scopeUnitIds));

      const unitLookup = new Map<string, string>();
      const registerUnitLookup = (
        value: string | null | undefined,
        unitId: string,
      ) => {
        const normalized = normalizeCsvText(value);
        const normalizedLoose = normalizeLooseCsvText(value);
        if (normalized) {
          unitLookup.set(normalized, unitId);
        }
        if (normalizedLoose) {
          unitLookup.set(normalizedLoose, unitId);
        }
      };
      const resolveUnitLookup = (value: string) =>
        unitLookup.get(normalizeCsvText(value)) ??
        unitLookup.get(normalizeLooseCsvText(value));
      for (const unit of scopedUnits) {
        registerUnitLookup(unit.id, unit.id);
        registerUnitLookup(unit.name, unit.id);
        registerUnitLookup(unit.code, unit.id);
      }
      const canCreateUnits = req.user!.role === "super_admin";
      const createUnitIfMissing = async (
        rawName: string,
        parentUnitId?: string | null,
      ): Promise<string | undefined> => {
        const name = rawName.trim();
        if (!name) return undefined;
        const matched = resolveUnitLookup(name);
        if (matched) return matched;
        if (!canCreateUnits) return undefined;
        const [createdUnit] = await db
          .insert(units)
          .values({
            name,
            code: null,
            parentUnitId: parentUnitId ?? undefined,
          })
          .returning({
            id: units.id,
            name: units.name,
            code: units.code,
          });
        registerUnitLookup(createdUnit.id, createdUnit.id);
        registerUnitLookup(createdUnit.name, createdUnit.id);
        registerUnitLookup(createdUnit.code, createdUnit.id);
        return createdUnit.id;
      };

      const scopedEmployees = await db
        .select({
          id: employees.id,
          employeeNo: employees.employeeNo,
          fullName: employees.fullName,
          email: employees.email,
          unitId: employees.unitId,
        })
        .from(employees)
        .where(and(inArray(employees.unitId, scopeUnitIds), employeeNotDeletedCondition()));

      const existingByEmail = new Map<
        string,
        (typeof scopedEmployees)[number]
      >();
      const scopedEmployeeIds = new Set<string>();
      const globalEmployeeByEmail = new Map<string, { id: string; unitId: string }>();
      const globalEmailCounts = new Map<string, number>();
      const processedCsvEmails = new Set<string>();

      for (const existing of scopedEmployees) {
        scopedEmployeeIds.add(existing.id);
        if (existing.email) {
          existingByEmail.set(normalizeCsvText(existing.email), existing);
        }
      }
      const allEmployeesWithEmail = await db
        .select({
          id: employees.id,
          email: employees.email,
          unitId: employees.unitId,
        })
        .from(employees)
        .where(and(sql`${employees.email} is not null`, employeeNotDeletedCondition()));
      for (const existing of allEmployeesWithEmail) {
        if (!existing.email) continue;
        const normalizedGlobalEmail = normalizeCsvText(existing.email);
        globalEmailCounts.set(
          normalizedGlobalEmail,
          (globalEmailCounts.get(normalizedGlobalEmail) ?? 0) + 1,
        );
        if (!globalEmployeeByEmail.has(normalizedGlobalEmail)) {
          globalEmployeeByEmail.set(normalizedGlobalEmail, {
            id: existing.id,
            unitId: existing.unitId,
          });
        }
      }
      const duplicateGlobalEmails = new Set<string>();
      for (const [emailKey, count] of globalEmailCounts.entries()) {
        if (count > 1) {
          duplicateGlobalEmails.add(emailKey);
        }
      }

      const summary = {
        total: records.length,
        created: 0,
        updated: 0,
        invalid: 0,
      };
      const errors: Array<{ row: number; employeeNo: string; message: string }> = [];

      for (let index = 0; index < records.length; index += 1) {
        const row = records[index];
        const fullName = useMalformedNuMapping
          ? getCsvRowValue(row, [
              "Full Name (Last Name",
              "Full Name (Last Name, First Name Middle Name)",
              "Full Name",
              "fullName",
              "full_name",
              "Name",
            ])
          : getCsvRowValue(row, [
              "Full Name (Last Name, First Name Middle Name)",
              "Full Name",
              "fullName",
              "full_name",
              "Name",
            ]);
        const department = useMalformedNuMapping
          ? getCsvRowValue(row, [
              "ASP/Official/Faculty",
              "Department/College",
              "Department",
              "department",
              "Unit",
              "Unit Name",
              "unitId",
              "Unit ID",
            ])
          : getCsvRowValue(row, [
              "Department/College",
              "Department",
              "department",
              "Unit",
              "Unit Name",
              "unitId",
              "Unit ID",
            ]);
        const division = useMalformedNuMapping
          ? getCsvRowValue(row, ["Department/College", "Division", "division"])
          : getCsvRowValue(row, ["Division", "division"]);
        const email = getCsvRowValue(row, ["NU Email", "Email", "email"]);
        const positionRaw = getCsvRowValue(row, ["Position", "position"]);
        const employeeType = useMalformedNuMapping
          ? getCsvRowValue(row, [
              "First Name Middle Name)",
              "ASP/Official/Faculty",
              "Employee Type",
              "Type",
            ])
          : getCsvRowValue(row, [
              "ASP/Official/Faculty",
              "Employee Type",
              "Type",
            ]);
        const position = positionRaw || employeeType;
        const employmentStatusRaw = getCsvRowValue(row, [
          "Employment Status",
          "employmentStatus",
          "Status",
          "status",
        ]);

        if (!fullName) {
          summary.invalid += 1;
          errors.push({
            row: index + 2,
            employeeNo: email || fullName || "",
            message: "Full Name is required.",
          });
          continue;
        }

        const normalizedEmail = normalizeCsvText(email);
        if (!normalizedEmail) {
          summary.invalid += 1;
          errors.push({
            row: index + 2,
            employeeNo: fullName,
            message: "NU Email is required.",
          });
          continue;
        }
        const isEmailValid = z.string().email().safeParse(normalizedEmail).success;
        if (!isEmailValid) {
          summary.invalid += 1;
          errors.push({
            row: index + 2,
            employeeNo: email || fullName,
            message: "Invalid email format.",
          });
          continue;
        }
        if (duplicateGlobalEmails.has(normalizedEmail)) {
          summary.invalid += 1;
          errors.push({
            row: index + 2,
            employeeNo: email || fullName,
            message:
              "This email already has duplicate employee records. Resolve duplicates first, then re-upload.",
          });
          continue;
        }
        if (processedCsvEmails.has(normalizedEmail)) {
          summary.invalid += 1;
          errors.push({
            row: index + 2,
            employeeNo: email || fullName,
            message: "Duplicate NU Email in uploaded CSV.",
          });
          continue;
        }

        const resolvedDepartmentLabel = department || division || "Unassigned";
        let unitId = resolveUnitLookup(resolvedDepartmentLabel);
        if (!unitId) {
          const divisionId =
            division && normalizeCsvText(division) !== normalizeCsvText(resolvedDepartmentLabel)
              ? await createUnitIfMissing(division)
              : undefined;
          unitId = await createUnitIfMissing(resolvedDepartmentLabel, divisionId);
        }
        if (!unitId) {
          summary.invalid += 1;
          errors.push({
            row: index + 2,
            employeeNo: email || fullName,
            message: "Department not found or out of scope.",
          });
          continue;
        }

        let employmentStatus: "active" | "inactive" = "active";
        if (employmentStatusRaw) {
          const normalizedStatus = normalizeCsvText(employmentStatusRaw);
          if (normalizedStatus !== "active" && normalizedStatus !== "inactive") {
            summary.invalid += 1;
            errors.push({
              row: index + 2,
              employeeNo: email || fullName,
              message: "Employment Status must be active or inactive.",
            });
            continue;
          }
          employmentStatus = normalizedStatus;
        }

        const existing = existingByEmail.get(normalizedEmail);
        const existingGlobal = globalEmployeeByEmail.get(normalizedEmail);
        if (!existing && existingGlobal && !scopedEmployeeIds.has(existingGlobal.id)) {
          summary.invalid += 1;
          errors.push({
            row: index + 2,
            employeeNo: email || fullName,
            message: "Email already exists outside your accessible scope.",
          });
          continue;
        }
        if (existing) {
          const [updated] = await db
            .update(employees)
            .set({
              fullName,
              email: normalizedEmail,
              employeeNo: normalizedEmail,
              unitId,
              position: position || null,
              employmentStatus,
              updatedAt: new Date(),
            })
            .where(and(eq(employees.id, existing.id), employeeNotDeletedCondition()))
            .returning();
          existingByEmail.set(normalizedEmail, updated);
          globalEmployeeByEmail.set(normalizedEmail, {
            id: updated.id,
            unitId: updated.unitId,
          });
          processedCsvEmails.add(normalizedEmail);
          summary.updated += 1;
          continue;
        }

        try {
          const [created] = await db
            .insert(employees)
            .values({
              employeeNo: normalizedEmail,
              fullName,
              email: normalizedEmail,
              unitId,
              position: position || null,
              employmentStatus,
              hireDate: null,
            })
            .returning();
          existingByEmail.set(normalizedEmail, created);
          scopedEmployeeIds.add(created.id);
          globalEmployeeByEmail.set(normalizedEmail, {
            id: created.id,
            unitId: created.unitId,
          });
          processedCsvEmails.add(normalizedEmail);
          summary.created += 1;
        } catch {
          summary.invalid += 1;
          errors.push({
            row: index + 2,
            employeeNo: email || fullName,
            message: "Unable to create employee row.",
          });
        }
      }

      await logAudit({
        actorUserId: req.user!.id,
        action: "employee.import",
        entityType: "employee",
        entityId: null,
        afterJson: {
          fileName: req.file.originalname,
          summary,
        },
        ip: req.ip,
      });

      res.status(201).json({
        summary,
        errors: errors.slice(0, 50),
      });
    },
  );

  api.put(
    "/employees/:id",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = employeeInputSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const employeeId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(employees)
        .where(and(eq(employees.id, employeeId), employeeNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Employee not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(existing.unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (parsed.data.unitId && !scopeUnitIds.includes(parsed.data.unitId)) {
        return res.status(403).json({ message: "Target unit out of scope." });
      }
      const incomingEmail =
        typeof parsed.data.email === "string"
          ? parsed.data.email.trim().toLowerCase()
          : undefined;
      if (parsed.data.email !== undefined && !incomingEmail) {
        return res.status(400).json({ message: "Email is required." });
      }
      if (incomingEmail) {
        const [duplicateEmail] = await db
          .select({ id: employees.id })
          .from(employees)
          .where(
            and(
              ilike(employees.email, incomingEmail),
              sql`${employees.id} <> ${employeeId}`,
              employeeNotDeletedCondition(),
            ),
          )
          .limit(1);
        if (duplicateEmail) {
          return res.status(409).json({ message: "An employee with this email already exists." });
        }
      }
      const nextEmail = incomingEmail ?? existing.email;
      if (!nextEmail) {
        return res.status(400).json({ message: "Employee email is required." });
      }
      const { email: _ignoredEmail, ...rest } = parsed.data;
      const [updated] = await db
        .update(employees)
        .set({
          ...rest,
          email: nextEmail,
          employeeNo: nextEmail,
          updatedAt: new Date(),
        })
        .where(and(eq(employees.id, employeeId), employeeNotDeletedCondition()))
        .returning();
      await logAudit({
        actorUserId: req.user!.id,
        action: "employee.update",
        entityType: "employee",
        entityId: employeeId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
    res.json({ employee: updated });
  },
  );

  api.delete(
    "/employees/:id",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = softDeleteSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const employeeId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(employees)
        .where(and(eq(employees.id, employeeId), employeeNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Employee not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(existing.unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      const now = new Date();
      const [deleted] = await db
        .update(employees)
        .set({
          deletedAt: now,
          deletedBy: req.user!.id,
          deleteReason: parsed.data.reason,
          updatedAt: now,
        })
        .where(and(eq(employees.id, employeeId), employeeNotDeletedCondition()))
        .returning();
      await logAudit({
        actorUserId: req.user!.id,
        action: "employee.soft_delete",
        entityType: "employee",
        entityId: employeeId,
        beforeJson: existing,
        afterJson: deleted,
        ip: req.ip,
      });
      res.json({ employee: deleted });
    },
  );

  api.get("/training-events", async (req, res) => {
    const scopeUnitIds = await getScopedUnitIds(req.user!);
    if (scopeUnitIds.length === 0) {
      return res.json({ trainingEvents: [] });
    }
    const querySchema = z.object({
      unitId: z.string().uuid().optional(),
      includeChildren: z.string().optional(),
      status: z.enum(["draft", "submitted", "returned", "approved", "locked"]).optional(),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const { unitId, includeChildren, status } = parsed.data;
    let allowedUnits = scopeUnitIds;
    if (unitId) {
      if (!scopeUnitIds.includes(unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      allowedUnits =
        includeChildren === "true"
          ? await getDescendantUnits(unitId, scopeUnitIds)
          : [unitId];
    }
    const filters = [trainingEventNotDeletedCondition()];
    if (status) {
      filters.push(eq(trainingEvents.workflowStatus, status));
    }
    const rows = await db
      .select()
      .from(trainingEvents)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(trainingEvents.startDate));
    const parentMap = await getUnitParentMap();
    const scopedRows = rows.filter((row) =>
      isTrainingEventVisibleToScope(row, allowedUnits, parentMap),
    );
    res.json({ trainingEvents: scopedRows });
  });

  api.post(
    "/training-events",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = trainingEventInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(parsed.data.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (isStartDateAfterEndDate(parsed.data.startDate, parsed.data.endDate)) {
        return res.status(400).json({
          message: "Start date must be on or before end date.",
        });
      }
      const [created] = await db
        .insert(trainingEvents)
        .values({
          ...parsed.data,
          hours: parsed.data.hours.toString(),
          visibilityScope: parsed.data.visibilityScope ?? "unit",
          isMandatory: parsed.data.isMandatory ?? false,
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        })
        .returning();
      await logAudit({
        actorUserId: req.user!.id,
        action: "training_event.create",
        entityType: "training_event",
        entityId: created.id,
        afterJson: created,
        ip: req.ip,
      });
      res.status(201).json({ trainingEvent: created });
    },
  );

  api.put(
    "/training-events/:id",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = trainingEventInputSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const eventId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(existing.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (parsed.data.ownerUnitId && !scopeUnitIds.includes(parsed.data.ownerUnitId)) {
        return res.status(403).json({ message: "Target unit out of scope." });
      }
      const isSuperAdmin = req.user?.role === "super_admin";
      if (!isEditableStatus(existing.workflowStatus) && !isSuperAdmin) {
        return res.status(400).json({ message: "Training event is not editable." });
      }
      const nextStartDate = parsed.data.startDate ?? existing.startDate;
      const nextEndDate = parsed.data.endDate ?? existing.endDate;
      if (isStartDateAfterEndDate(nextStartDate, nextEndDate)) {
        return res.status(400).json({
          message: "Start date must be on or before end date.",
        });
      }
      const [updated] = await db
        .update(trainingEvents)
        .set({
          ...parsed.data,
          hours: parsed.data.hours ? parsed.data.hours.toString() : undefined,
          updatedBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .returning();
      await logAudit({
        actorUserId: req.user!.id,
        action: "training_event.update",
        entityType: "training_event",
        entityId: eventId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
      res.json({ trainingEvent: updated });
    },
  );

  api.delete(
    "/training-events/:id",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = softDeleteSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const eventId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(existing.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      const now = new Date();
      const [deleted] = await db
        .update(trainingEvents)
        .set({
          deletedAt: now,
          deletedBy: req.user!.id,
          deleteReason: parsed.data.reason,
          updatedBy: req.user!.id,
          updatedAt: now,
        })
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .returning();
      await logAudit({
        actorUserId: req.user!.id,
        action: "training_event.soft_delete",
        entityType: "training_event",
        entityId: eventId,
        beforeJson: existing,
        afterJson: deleted,
        ip: req.ip,
      });
      res.json({ trainingEvent: deleted });
    },
  );

  api.post(
    "/training-events/:id/submit",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    async (req, res) => {
      const eventId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(existing.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (!isEditableStatus(existing.workflowStatus)) {
        return res.status(400).json({ message: "Training event cannot be submitted." });
      }
      const [updated] = await db
        .update(trainingEvents)
        .set({
          workflowStatus: "submitted",
          updatedBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .returning();
      await logWorkflowAction({
        entityType: "training_event",
        entityId: eventId,
        action: "submit",
        actorUserId: req.user!.id,
      });
      await logAudit({
        actorUserId: req.user!.id,
        action: "training_event.submit",
        entityType: "training_event",
        entityId: eventId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
      res.json({ trainingEvent: updated });
    },
  );

  api.post(
    "/training-events/:id/return",
    requireRole(["super_admin", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = returnSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const eventId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(existing.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (!isSubmittedStatus(existing.workflowStatus)) {
        return res.status(400).json({ message: "Training event cannot be returned." });
      }
      const [updated] = await db
        .update(trainingEvents)
        .set({
          workflowStatus: "returned",
          returnNotes: parsed.data.notes,
          updatedBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .returning();
      await logWorkflowAction({
        entityType: "training_event",
        entityId: eventId,
        action: "return",
        actorUserId: req.user!.id,
        notes: parsed.data.notes,
      });
      await logAudit({
        actorUserId: req.user!.id,
        action: "training_event.return",
        entityType: "training_event",
        entityId: eventId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
      res.json({ trainingEvent: updated });
    },
  );

  api.post(
    "/training-events/:id/approve",
    requireRole(["super_admin", "hr_qa_approver"]),
    async (req, res) => {
      const eventId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(existing.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (!isSubmittedStatus(existing.workflowStatus)) {
        return res.status(400).json({ message: "Training event cannot be approved." });
      }
      const [updated] = await db
        .update(trainingEvents)
        .set({
          workflowStatus: "approved",
          updatedBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .returning();
      await logWorkflowAction({
        entityType: "training_event",
        entityId: eventId,
        action: "approve",
        actorUserId: req.user!.id,
      });
      await logAudit({
        actorUserId: req.user!.id,
        action: "training_event.approve",
        entityType: "training_event",
        entityId: eventId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
      res.json({ trainingEvent: updated });
    },
  );

  api.post(
    "/training-events/:id/lock",
    requireRole(["super_admin", "hr_qa_approver"]),
    async (req, res) => {
      const eventId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(existing.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (existing.workflowStatus !== "approved") {
        return res
          .status(400)
          .json({ message: "Training event must be approved before locking." });
      }
      const [updated] = await db
        .update(trainingEvents)
        .set({
          workflowStatus: "locked",
          updatedBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .returning();
      await logWorkflowAction({
        entityType: "training_event",
        entityId: eventId,
        action: "lock",
        actorUserId: req.user!.id,
      });
      await logAudit({
        actorUserId: req.user!.id,
        action: "training_event.lock",
        entityType: "training_event",
        entityId: eventId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
      res.json({ trainingEvent: updated });
    },
  );

  api.post(
    "/training-events/:id/reopen",
    requireRole(["super_admin", "hr_qa_approver"]),
    async (req, res) => {
      const eventId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(existing.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (existing.workflowStatus !== "locked") {
        return res.status(400).json({ message: "Training event is not locked." });
      }
      const [updated] = await db
        .update(trainingEvents)
        .set({
          workflowStatus: "draft",
          updatedBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(and(eq(trainingEvents.id, eventId), trainingEventNotDeletedCondition()))
        .returning();
      await logWorkflowAction({
        entityType: "training_event",
        entityId: eventId,
        action: "reopen",
        actorUserId: req.user!.id,
      });
      await logAudit({
        actorUserId: req.user!.id,
        action: "training_event.reopen",
        entityType: "training_event",
        entityId: eventId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
      res.json({ trainingEvent: updated });
    },
  );

  api.get("/attendance", async (req, res) => {
    const scopeUnitIds = await getScopedUnitIds(req.user!);
    if (scopeUnitIds.length === 0) {
      return res.json({ attendance: [] });
    }
    const querySchema = z.object({
      trainingEventId: z.string().uuid().optional(),
      employeeId: z.string().uuid().optional(),
      unitId: z.string().uuid().optional(),
      includeChildren: z.string().optional(),
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    let allowedUnits = scopeUnitIds;
    if (parsed.data.unitId) {
      if (!scopeUnitIds.includes(parsed.data.unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      allowedUnits =
        parsed.data.includeChildren === "true"
          ? await getDescendantUnits(parsed.data.unitId, scopeUnitIds)
          : [parsed.data.unitId];
    }
    const employeeRows = await db
      .select({ id: employees.id })
      .from(employees)
      .where(and(inArray(employees.unitId, allowedUnits), employeeNotDeletedCondition()));
    const employeeIds = employeeRows.map((row) => row.id);
    if (employeeIds.length === 0) {
      return res.json({ attendance: [] });
    }
    const filters = [inArray(attendanceRecords.employeeId, employeeIds), attendanceNotDeletedCondition()];
    if (parsed.data.trainingEventId) {
      filters.push(eq(attendanceRecords.trainingEventId, parsed.data.trainingEventId));
    }
    if (parsed.data.employeeId) {
      filters.push(eq(attendanceRecords.employeeId, parsed.data.employeeId));
    }
    const rows = await db
      .select()
      .from(attendanceRecords)
      .where(and(...filters))
      .orderBy(desc(attendanceRecords.attendanceDate));
    res.json({ attendance: rows });
  });

  api.post(
    "/attendance",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = attendanceInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const [employeeRow] = await db
        .select({ unitId: employees.unitId })
        .from(employees)
        .where(and(eq(employees.id, parsed.data.employeeId), employeeNotDeletedCondition()))
        .limit(1);
      if (!employeeRow) {
        return res.status(404).json({ message: "Employee not found." });
      }
      const [trainingEventRow] = await db
        .select({ ownerUnitId: trainingEvents.ownerUnitId })
        .from(trainingEvents)
        .where(and(eq(trainingEvents.id, parsed.data.trainingEventId), trainingEventNotDeletedCondition()))
        .limit(1);
      if (!trainingEventRow) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(employeeRow.unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (!scopeUnitIds.includes(trainingEventRow.ownerUnitId)) {
        return res.status(403).json({ message: "Training event out of scope." });
      }
      if (parsed.data.employeeId) {
        const [targetEmployee] = await db
          .select({ unitId: employees.unitId })
          .from(employees)
          .where(and(eq(employees.id, parsed.data.employeeId), employeeNotDeletedCondition()))
          .limit(1);
        if (!targetEmployee || !scopeUnitIds.includes(targetEmployee.unitId)) {
          return res.status(403).json({ message: "Target employee out of scope." });
        }
      }
      if (parsed.data.trainingEventId) {
        const [targetEvent] = await db
          .select({ ownerUnitId: trainingEvents.ownerUnitId })
          .from(trainingEvents)
          .where(and(eq(trainingEvents.id, parsed.data.trainingEventId), trainingEventNotDeletedCondition()))
          .limit(1);
        if (!targetEvent || !scopeUnitIds.includes(targetEvent.ownerUnitId)) {
          return res.status(403).json({ message: "Target training event out of scope." });
        }
      }
      const [created] = await db
        .insert(attendanceRecords)
        .values({
          ...parsed.data,
          hoursCredited: parsed.data.hoursCredited.toString(),
          attendanceStatus: parsed.data.attendanceStatus ?? "present",
          createdBy: req.user!.id,
          updatedBy: req.user!.id,
        })
        .returning();
      await logAudit({
        actorUserId: req.user!.id,
        action: "attendance.create",
        entityType: "attendance_record",
        entityId: created.id,
        afterJson: created,
        ip: req.ip,
      });
      res.status(201).json({ attendance: created });
    },
  );

  api.put(
    "/attendance/:id",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = attendanceInputSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const attendanceId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Attendance record not found." });
      }
      if (!isEditableStatus(existing.workflowStatus)) {
        return res.status(400).json({ message: "Attendance record is not editable." });
      }
      const [employeeRow] = await db
        .select({ unitId: employees.unitId })
        .from(employees)
        .where(and(eq(employees.id, existing.employeeId), employeeNotDeletedCondition()))
        .limit(1);
      if (!employeeRow) {
        return res.status(404).json({ message: "Employee not found." });
      }
      const [trainingEventRow] = await db
        .select({ ownerUnitId: trainingEvents.ownerUnitId })
        .from(trainingEvents)
        .where(and(eq(trainingEvents.id, existing.trainingEventId), trainingEventNotDeletedCondition()))
        .limit(1);
      if (!trainingEventRow) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(employeeRow.unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (!scopeUnitIds.includes(trainingEventRow.ownerUnitId)) {
        return res.status(403).json({ message: "Training event out of scope." });
      }
      const [updated] = await db
        .update(attendanceRecords)
        .set({
          ...parsed.data,
          hoursCredited: parsed.data.hoursCredited
            ? parsed.data.hoursCredited.toString()
            : undefined,
          updatedBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .returning();
      await logAudit({
        actorUserId: req.user!.id,
        action: "attendance.update",
        entityType: "attendance_record",
        entityId: attendanceId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
      res.json({ attendance: updated });
    },
  );

  api.delete(
    "/attendance/:id",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = softDeleteSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const attendanceId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Attendance record not found." });
      }
      const allowed = await isEntityInScope(
        "attendance_record",
        attendanceId,
        await getScopedUnitIds(req.user!),
      );
      if (!allowed) {
        return res.status(403).json({ message: "Attendance record out of scope." });
      }
      const now = new Date();
      const [deleted] = await db
        .update(attendanceRecords)
        .set({
          deletedAt: now,
          deletedBy: req.user!.id,
          deleteReason: parsed.data.reason,
          updatedBy: req.user!.id,
          updatedAt: now,
        })
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .returning();
      await logAudit({
        actorUserId: req.user!.id,
        action: "attendance.soft_delete",
        entityType: "attendance_record",
        entityId: attendanceId,
        beforeJson: existing,
        afterJson: deleted,
        ip: req.ip,
      });
      res.json({ attendance: deleted });
    },
  );

  api.post(
    "/attendance/:id/submit",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    async (req, res) => {
      const attendanceId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Attendance record not found." });
      }
      if (!isEditableStatus(existing.workflowStatus)) {
        return res.status(400).json({ message: "Attendance record cannot be submitted." });
      }
      const [updated] = await db
        .update(attendanceRecords)
        .set({
          workflowStatus: "submitted",
          updatedBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .returning();
      await logWorkflowAction({
        entityType: "attendance_record",
        entityId: attendanceId,
        action: "submit",
        actorUserId: req.user!.id,
      });
      await logAudit({
        actorUserId: req.user!.id,
        action: "attendance.submit",
        entityType: "attendance_record",
        entityId: attendanceId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
      res.json({ attendance: updated });
    },
  );

  api.post(
    "/attendance/:id/return",
    requireRole(["super_admin", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = returnSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const attendanceId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Attendance record not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      const allowed = await isEntityInScope("attendance_record", attendanceId, scopeUnitIds);
      if (!allowed) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (!isSubmittedStatus(existing.workflowStatus)) {
        return res.status(400).json({ message: "Attendance record cannot be returned." });
      }
      const [updated] = await db
        .update(attendanceRecords)
        .set({
          workflowStatus: "returned",
          returnNotes: parsed.data.notes,
          updatedBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .returning();
      await logWorkflowAction({
        entityType: "attendance_record",
        entityId: attendanceId,
        action: "return",
        actorUserId: req.user!.id,
        notes: parsed.data.notes,
      });
      await logAudit({
        actorUserId: req.user!.id,
        action: "attendance.return",
        entityType: "attendance_record",
        entityId: attendanceId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
      res.json({ attendance: updated });
    },
  );

  api.post(
    "/attendance/:id/approve",
    requireRole(["super_admin", "hr_qa_approver"]),
    async (req, res) => {
      const attendanceId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Attendance record not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      const allowed = await isEntityInScope("attendance_record", attendanceId, scopeUnitIds);
      if (!allowed) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (!isSubmittedStatus(existing.workflowStatus)) {
        return res.status(400).json({ message: "Attendance record cannot be approved." });
      }
      const [updated] = await db
        .update(attendanceRecords)
        .set({
          workflowStatus: "approved",
          updatedBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .returning();
      await logWorkflowAction({
        entityType: "attendance_record",
        entityId: attendanceId,
        action: "approve",
        actorUserId: req.user!.id,
      });
      await logAudit({
        actorUserId: req.user!.id,
        action: "attendance.approve",
        entityType: "attendance_record",
        entityId: attendanceId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
      res.json({ attendance: updated });
    },
  );

  api.post(
    "/attendance/:id/lock",
    requireRole(["super_admin", "hr_qa_approver"]),
    async (req, res) => {
      const attendanceId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Attendance record not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      const allowed = await isEntityInScope("attendance_record", attendanceId, scopeUnitIds);
      if (!allowed) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (existing.workflowStatus !== "approved") {
        return res.status(400).json({
          message: "Attendance record must be approved before locking.",
        });
      }
      const [updated] = await db
        .update(attendanceRecords)
        .set({
          workflowStatus: "locked",
          updatedBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .returning();
      await logWorkflowAction({
        entityType: "attendance_record",
        entityId: attendanceId,
        action: "lock",
        actorUserId: req.user!.id,
      });
      await logAudit({
        actorUserId: req.user!.id,
        action: "attendance.lock",
        entityType: "attendance_record",
        entityId: attendanceId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
      res.json({ attendance: updated });
    },
  );

  api.post(
    "/attendance/:id/reopen",
    requireRole(["super_admin", "hr_qa_approver"]),
    async (req, res) => {
      const attendanceId = getRouteParam(req.params.id);
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Attendance record not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      const allowed = await isEntityInScope("attendance_record", attendanceId, scopeUnitIds);
      if (!allowed) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (existing.workflowStatus !== "locked") {
        return res.status(400).json({ message: "Attendance record is not locked." });
      }
      const [updated] = await db
        .update(attendanceRecords)
        .set({
          workflowStatus: "draft",
          updatedBy: req.user!.id,
          updatedAt: new Date(),
        })
        .where(and(eq(attendanceRecords.id, attendanceId), attendanceNotDeletedCondition()))
        .returning();
      await logWorkflowAction({
        entityType: "attendance_record",
        entityId: attendanceId,
        action: "reopen",
        actorUserId: req.user!.id,
      });
      await logAudit({
        actorUserId: req.user!.id,
        action: "attendance.reopen",
        entityType: "attendance_record",
        entityId: attendanceId,
        beforeJson: existing,
        afterJson: updated,
        ip: req.ip,
      });
      res.json({ attendance: updated });
    },
  );

  api.post(
    "/attendance/import",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    csvUpload.single("file"),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ message: "CSV file is required." });
      }
      const trainingEventId = req.body.trainingEventId;
      if (!trainingEventId) {
        return res.status(400).json({ message: "trainingEventId is required." });
      }
      const [trainingEvent] = await db
        .select()
        .from(trainingEvents)
        .where(and(eq(trainingEvents.id, trainingEventId), trainingEventNotDeletedCondition()))
        .limit(1);
      if (!trainingEvent) {
        return res.status(404).json({ message: "Training event not found." });
      }
      if (!isImportableTrainingEventStatus(trainingEvent.workflowStatus)) {
        return res.status(400).json({
          message: "Training event status does not allow attendance import.",
        });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(trainingEvent.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      const selectedEventTitleKey = normalizeCsvText(trainingEvent.title);
      const selectedEventTitleLooseKey = normalizeAttendanceTitleKey(trainingEvent.title);
      const fileHash = createHash("sha256").update(req.file.buffer).digest("hex");
      const [existingBatch] = await db
        .select()
        .from(attendanceImportBatches)
        .where(
          and(
            eq(attendanceImportBatches.trainingEventId, trainingEventId),
            sql`${attendanceImportBatches.summaryJson} ->> 'fileHash' = ${fileHash}`,
            inArray(attendanceImportBatches.status, ["parsed", "needs_review", "committed"]),
          ),
        )
        .orderBy(desc(attendanceImportBatches.createdAt))
        .limit(1);
      if (existingBatch) {
        if (existingBatch.status !== "committed") {
          const existingRows = await db
            .select()
            .from(attendanceImportRows)
            .where(eq(attendanceImportRows.batchId, existingBatch.id));
          return res.status(200).json({
            batch: existingBatch,
            rows: existingRows,
            reusedExistingBatch: true,
          });
        }
      }
      const rawCsv = req.file.buffer.toString("utf-8");
      let parsedHeaders: string[] = [];
      let records: Record<string, string>[] = [];
      try {
        records = parse(rawCsv, {
          columns: (headers: string[]) => {
            parsedHeaders = headers.map((header) => header.trim());
            return parsedHeaders;
          },
          skip_empty_lines: true,
          trim: true,
          bom: true,
        }) as Record<string, string>[];
      } catch {
        return res.status(400).json({ message: "Invalid CSV format." });
      }

      const hasExpectedHeaders = requiredAttendanceCsvHeaders.every((header) =>
        parsedHeaders.includes(header),
      );
      const hasOnlyExpectedHeaders =
        parsedHeaders.length === requiredAttendanceCsvHeaders.length &&
        parsedHeaders.every((header) =>
          requiredAttendanceCsvHeaders.includes(
            header as (typeof requiredAttendanceCsvHeaders)[number],
          ),
        );
      if (!hasExpectedHeaders || !hasOnlyExpectedHeaders) {
        return res.status(400).json({
          message: "Invalid CSV schema. Required columns are: Email, Participants, Date, Title.",
        });
      }

      const employeeRows = await db
        .select({
          id: employees.id,
          employeeNo: employees.employeeNo,
          email: employees.email,
          fullName: employees.fullName,
        })
        .from(employees)
        .where(and(inArray(employees.unitId, scopeUnitIds), employeeNotDeletedCondition()));

      type ScopedEmployee = (typeof employeeRows)[number];
      const employeeEmailMap = new Map<string, ScopedEmployee[]>();
      for (const employee of employeeRows) {
        if (!employee.email) continue;
        const key = normalizeCsvText(employee.email);
        const list = employeeEmailMap.get(key) ?? [];
        list.push(employee);
        employeeEmailMap.set(key, list);
      }

      const rowsToInsert: Array<{
        rawRowJson: Record<string, string>;
        employeeNo: string;
        resolvedEmployeeId?: string;
        matchStatus: "matched" | "unmatched" | "invalid";
        errorMessage: string | null;
      }> = [];
      let matched = 0;
      let unmatched = 0;
      let invalid = 0;

      for (const row of records) {
        const emailValue = (row.Email ?? "").trim();
        const participantsValue = (row.Participants ?? "").trim();
        const titleValue = (row.Title ?? "").trim();
        const dateValue = (row.Date ?? "").trim();

        if (!titleValue || !dateValue) {
          rowsToInsert.push({
            rawRowJson: row,
            employeeNo: emailValue || participantsValue || "unknown",
            matchStatus: "invalid",
            errorMessage: "Missing required values for Title or Date.",
          });
          invalid += 1;
          continue;
        }
        const csvTitleKey = normalizeCsvText(titleValue);
        const csvTitleLooseKey = normalizeAttendanceTitleKey(titleValue);
        const isTitleMatch =
          csvTitleKey === selectedEventTitleKey ||
          csvTitleLooseKey === selectedEventTitleLooseKey;
        if (!isTitleMatch) {
          rowsToInsert.push({
            rawRowJson: row,
            employeeNo: emailValue || participantsValue || "unknown",
            matchStatus: "invalid",
            errorMessage: `Title does not match selected event (${trainingEvent.title}).`,
          });
          invalid += 1;
          continue;
        }

        const parsedDates = parseAttendanceCsvDates(dateValue);
        if (parsedDates.error || parsedDates.dates.length === 0) {
          rowsToInsert.push({
            rawRowJson: row,
            employeeNo: emailValue || participantsValue,
            matchStatus: "invalid",
            errorMessage: parsedDates.error ?? "Invalid date format.",
          });
          invalid += 1;
          continue;
        }
        const normalizedEmail = normalizeCsvText(emailValue);
        if (!normalizedEmail) {
          rowsToInsert.push({
            rawRowJson: row,
            employeeNo: participantsValue || "unknown",
            matchStatus: "invalid",
            errorMessage: "Email is required and is used as the unique employee key.",
          });
          invalid += 1;
          continue;
        }
        const isEmailValid = z.string().email().safeParse(normalizedEmail).success;
        if (!isEmailValid) {
          rowsToInsert.push({
            rawRowJson: row,
            employeeNo: emailValue,
            matchStatus: "invalid",
            errorMessage: "Invalid email format in Email column.",
          });
          invalid += 1;
          continue;
        }

        const employeeMatches = employeeEmailMap.get(normalizedEmail) ?? [];
        if (employeeMatches.length > 1) {
          rowsToInsert.push({
            rawRowJson: row,
            employeeNo: emailValue,
            matchStatus: "unmatched",
            errorMessage:
              "Multiple employees share this email. Resolve employee duplicates first.",
          });
          unmatched += 1;
          continue;
        }
        const matchedEmployee = employeeMatches[0];
        if (!matchedEmployee) {
          rowsToInsert.push({
            rawRowJson: row,
            employeeNo: emailValue,
            matchStatus: "unmatched",
            errorMessage: "Employee not found by Email.",
          });
          unmatched += 1;
          continue;
        }

        rowsToInsert.push({
          rawRowJson: row,
          employeeNo: matchedEmployee.email || matchedEmployee.employeeNo,
          resolvedEmployeeId: matchedEmployee.id,
          matchStatus: "matched",
          errorMessage: null,
        });
        matched += 1;
      }

      const [batch] = await db
        .insert(attendanceImportBatches)
        .values({
          trainingEventId,
          uploadedBy: req.user!.id,
          fileName: req.file.originalname,
          status: unmatched > 0 || invalid > 0 ? "needs_review" : "parsed",
          summaryJson: {
            total: records.length,
            matched,
            unmatched,
            invalid,
            fileHash,
          },
        })
        .returning();

      const insertedRows =
        rowsToInsert.length === 0
          ? []
          : await db
              .insert(attendanceImportRows)
              .values(
                rowsToInsert.map((row) => ({
                  batchId: batch.id,
                  rawRowJson: row.rawRowJson,
                  employeeNo: row.employeeNo,
                  resolvedEmployeeId: row.resolvedEmployeeId,
                  matchStatus: row.matchStatus,
                  errorMessage: row.errorMessage,
                })),
              )
              .returning();

      await logAudit({
        actorUserId: req.user!.id,
        action: "attendance_import.create",
        entityType: "attendance_import_batch",
        entityId: batch.id,
        afterJson: { batch, summary: batch.summaryJson },
        ip: req.ip,
      });

      res.status(201).json({ batch, rows: insertedRows });
    },
  );

  api.get(
    "/attendance/import/:batchId",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    async (req, res) => {
      const batchId = getRouteParam(req.params.batchId);
      const [batch] = await db
        .select()
        .from(attendanceImportBatches)
        .where(eq(attendanceImportBatches.id, batchId))
        .limit(1);
      if (!batch) {
        return res.status(404).json({ message: "Batch not found." });
      }

      const [trainingEvent] = await db
        .select({ ownerUnitId: trainingEvents.ownerUnitId })
        .from(trainingEvents)
        .where(and(eq(trainingEvents.id, batch.trainingEventId), trainingEventNotDeletedCondition()))
        .limit(1);
      if (!trainingEvent) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(trainingEvent.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }

      const rows = await db
        .select()
        .from(attendanceImportRows)
        .where(eq(attendanceImportRows.batchId, batchId));
      res.json({ batch, rows });
    },
  );

  api.post(
    "/attendance/import/:batchId/resolve",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = resolveRowsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const batchId = getRouteParam(req.params.batchId);
      const [batch] = await db
        .select()
        .from(attendanceImportBatches)
        .where(eq(attendanceImportBatches.id, batchId))
        .limit(1);
      if (!batch) {
        return res.status(404).json({ message: "Batch not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      for (const resolution of parsed.data.resolutions) {
        if (resolution.markInvalid) {
          await db
            .update(attendanceImportRows)
            .set({
              matchStatus: "invalid",
              resolvedEmployeeId: null,
              errorMessage: "Marked invalid",
            })
            .where(eq(attendanceImportRows.id, resolution.rowId));
          continue;
        }
        if (resolution.employeeId) {
          const [employeeRow] = await db
            .select({ unitId: employees.unitId })
            .from(employees)
            .where(and(eq(employees.id, resolution.employeeId), employeeNotDeletedCondition()))
            .limit(1);
          if (!employeeRow || !scopeUnitIds.includes(employeeRow.unitId)) {
            return res.status(403).json({ message: "Employee out of scope." });
          }
          await db
            .update(attendanceImportRows)
            .set({
              matchStatus: "matched",
              resolvedEmployeeId: resolution.employeeId,
              errorMessage: null,
            })
            .where(eq(attendanceImportRows.id, resolution.rowId));
        }
      }
      const rows = await db
        .select()
        .from(attendanceImportRows)
        .where(eq(attendanceImportRows.batchId, batchId));
      res.json({ rows });
    },
  );

  api.post(
    "/attendance/import/:batchId/commit",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    async (req, res) => {
      const parsed = commitImportSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const batchId = getRouteParam(req.params.batchId);
      const [batch] = await db
        .select()
        .from(attendanceImportBatches)
        .where(eq(attendanceImportBatches.id, batchId))
        .limit(1);
      if (!batch) {
        return res.status(404).json({ message: "Batch not found." });
      }
      if (batch.status === "committed") {
        return res.status(409).json({ message: "This import batch was already committed." });
      }
      const [trainingEvent] = await db
        .select({
          ownerUnitId: trainingEvents.ownerUnitId,
          hours: trainingEvents.hours,
        })
        .from(trainingEvents)
        .where(and(eq(trainingEvents.id, batch.trainingEventId), trainingEventNotDeletedCondition()))
        .limit(1);
      if (!trainingEvent) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (!scopeUnitIds.includes(trainingEvent.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      const rows = await db
        .select()
        .from(attendanceImportRows)
        .where(eq(attendanceImportRows.batchId, batchId));

      const decisions = new Map(parsed.data.decisions?.map((d) => [d.rowId, d.action]));
      const results = { created: 0, updated: 0, skipped: 0 };
      const processedAttendanceKeys = new Set<string>();

      for (const row of rows) {
        if (row.matchStatus !== "matched" || !row.resolvedEmployeeId) {
          continue;
        }
        const raw = row.rawRowJson as Record<string, string>;
        const rawDateValue =
          raw.Date ||
          raw.attendance_date ||
          raw.attendanceDate ||
          raw["Attendance Date"] ||
          raw["attendance date"];
        const parsedDates = parseAttendanceCsvDates(rawDateValue);
        if (parsedDates.error || parsedDates.dates.length === 0) {
          continue;
        }
        const hoursCredited =
          raw.hours_credited ||
          raw.hoursCredited ||
          raw["Hours"] ||
          trainingEvent.hours.toString();
        const attendanceStatus =
          raw.attendance_status || raw.attendanceStatus || raw["Status"] || "present";
        const normalizedStatus: "present" | "absent" | "partial" = [
          "present",
          "absent",
          "partial",
        ].includes(attendanceStatus.toLowerCase())
          ? (attendanceStatus.toLowerCase() as "present" | "absent" | "partial")
          : "present";

        for (const attendanceDate of parsedDates.dates) {
          const importAttendanceKey = `${row.resolvedEmployeeId}::${attendanceDate}`;
          if (processedAttendanceKeys.has(importAttendanceKey)) {
            results.skipped += 1;
            continue;
          }
          processedAttendanceKeys.add(importAttendanceKey);

          const [existing] = await db
            .select()
            .from(attendanceRecords)
            .where(
              and(
                eq(attendanceRecords.trainingEventId, batch.trainingEventId),
                eq(attendanceRecords.employeeId, row.resolvedEmployeeId),
                eq(attendanceRecords.attendanceDate, attendanceDate),
              ),
            )
            .limit(1);

          if (existing) {
            if (existing.deletedAt) {
              await db
                .update(attendanceRecords)
                .set({
                  deletedAt: null,
                  deletedBy: null,
                  deleteReason: null,
                  returnNotes: null,
                  hoursCredited: hoursCredited.toString(),
                  attendanceStatus: normalizedStatus,
                  workflowStatus: "draft",
                  updatedBy: req.user!.id,
                  updatedAt: new Date(),
                })
                .where(eq(attendanceRecords.id, existing.id));
              results.updated += 1;
              continue;
            }
            const decision = decisions.get(row.id) ?? "skip";
            if (decision === "skip") {
              results.skipped += 1;
              continue;
            }
            await db
              .update(attendanceRecords)
              .set({
                hoursCredited: hoursCredited.toString(),
                attendanceStatus: normalizedStatus,
                updatedBy: req.user!.id,
                updatedAt: new Date(),
              })
              .where(and(eq(attendanceRecords.id, existing.id), attendanceNotDeletedCondition()));
            results.updated += 1;
          } else {
            await db.insert(attendanceRecords).values({
              trainingEventId: batch.trainingEventId,
              employeeId: row.resolvedEmployeeId,
              attendanceDate,
              hoursCredited: hoursCredited.toString(),
              attendanceStatus: normalizedStatus,
              workflowStatus: "draft",
              createdBy: req.user!.id,
              updatedBy: req.user!.id,
            });
            results.created += 1;
          }
        }
      }

      await db
        .update(attendanceImportBatches)
        .set({ status: "committed" })
        .where(eq(attendanceImportBatches.id, batchId));

      await logAudit({
        actorUserId: req.user!.id,
        action: "attendance_import.commit",
        entityType: "attendance_import_batch",
        entityId: batchId,
        afterJson: results,
        ip: req.ip,
      });

      res.json({ results });
    },
  );

  api.post(
    "/attachments/upload",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head", "hr_qa_approver"]),
    attachmentUpload.single("file"),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ message: "File is required." });
      }
      const schema = z.object({
        entityType: z.enum(["attendance_record", "training_event", "employee"]),
        entityId: z.string().uuid(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      const allowed = await isEntityInScope(
        parsed.data.entityType,
        parsed.data.entityId,
        scopeUnitIds,
      );
      if (!allowed) {
        return res.status(403).json({ message: "Entity out of scope." });
      }
      const [attachment] = await db
        .insert(attachments)
        .values({
          entityType: parsed.data.entityType,
          entityId: parsed.data.entityId,
          fileName: req.file.originalname,
          mimeType: req.file.mimetype,
          sizeBytes: req.file.size,
          storagePath: path.relative(process.cwd(), req.file.path),
          uploadedBy: req.user!.id,
        })
        .returning();

      await logAudit({
        actorUserId: req.user!.id,
        action: "attachment.upload",
        entityType: "attachment",
        entityId: attachment.id,
        afterJson: attachment,
        ip: req.ip,
      });

      res.status(201).json({ attachment });
    },
  );

  api.get("/attachments", async (req, res) => {
    const schema = z.object({
      entityType: z.enum(["attendance_record", "training_event", "employee"]),
      entityId: z.string().uuid(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const scopeUnitIds = await getScopedUnitIds(req.user!);
    const allowed = await isEntityInScope(
      parsed.data.entityType,
      parsed.data.entityId,
      scopeUnitIds,
    );
    if (!allowed) {
      return res.status(403).json({ message: "Entity out of scope." });
    }
    const rows = await db
      .select()
      .from(attachments)
      .where(
        and(
          eq(attachments.entityType, parsed.data.entityType),
          eq(attachments.entityId, parsed.data.entityId),
        ),
      )
      .orderBy(desc(attachments.uploadedAt));
    res.json({ attachments: rows });
  });

  api.get("/attachments/:id/download", async (req, res) => {
    const attachmentId = getRouteParam(req.params.id);
    const [attachment] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    if (!attachment) {
      return res.status(404).json({ message: "Attachment not found." });
    }
    const scopeUnitIds = await getScopedUnitIds(req.user!);
    const allowed = await isEntityInScope(
      attachment.entityType,
      attachment.entityId,
      scopeUnitIds,
    );
    if (!allowed) {
      return res.status(403).json({ message: "Entity out of scope." });
    }
    const filePath = path.resolve(attachment.storagePath);
    res.setHeader("Content-Type", attachment.mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${attachment.fileName}"`,
    );
    const stream = createReadStream(filePath);
    stream.on("error", () => {
      res.status(404).end();
    });
    stream.pipe(res);
  });

  api.delete(
    "/attachments/:id",
    requireRole(["super_admin", "hr_qa_approver"]),
    async (req, res) => {
      const attachmentId = getRouteParam(req.params.id);
      const [attachment] = await db
        .select()
        .from(attachments)
        .where(eq(attachments.id, attachmentId))
        .limit(1);
      if (!attachment) {
        return res.status(404).json({ message: "Attachment not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      const allowed = await isEntityInScope(
        attachment.entityType,
        attachment.entityId,
        scopeUnitIds,
      );
      if (!allowed) {
        return res.status(403).json({ message: "Entity out of scope." });
      }
      await db.delete(attachments).where(eq(attachments.id, attachmentId));
      await logAudit({
        actorUserId: req.user!.id,
        action: "attachment.delete",
        entityType: "attachment",
        entityId: attachmentId,
        beforeJson: attachment,
        ip: req.ip,
      });
      res.json({ ok: true });
    },
  );

  api.get("/dashboard/activities", async (req, res) => {
    const parsed = dashboardActivityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }

    const scopeUnitIds = await getScopedUnitIds(req.user!);
    if (scopeUnitIds.length === 0) {
      return res.json({ activities: [] });
    }

    const limit = parsed.data.limit ?? 10;
    const sourceLimit = Math.max(limit * 3, 24);

    const employeeRows = await db
      .select({
        id: employees.id,
        employeeNo: employees.employeeNo,
        fullName: employees.fullName,
        createdAt: employees.createdAt,
        updatedAt: employees.updatedAt,
      })
      .from(employees)
      .where(and(inArray(employees.unitId, scopeUnitIds), employeeNotDeletedCondition()))
      .orderBy(desc(employees.updatedAt))
      .limit(sourceLimit);

    const trainingRows = await db
      .select({
        id: trainingEvents.id,
        title: trainingEvents.title,
        startDate: trainingEvents.startDate,
        workflowStatus: trainingEvents.workflowStatus,
        createdAt: trainingEvents.createdAt,
        updatedAt: trainingEvents.updatedAt,
      })
      .from(trainingEvents)
      .where(and(inArray(trainingEvents.ownerUnitId, scopeUnitIds), trainingEventNotDeletedCondition()))
      .orderBy(desc(trainingEvents.updatedAt))
      .limit(sourceLimit);

    const attendanceRows = await db
      .select({
        id: attendanceRecords.id,
        trainingEventId: attendanceRecords.trainingEventId,
        workflowStatus: attendanceRecords.workflowStatus,
        attendanceDate: attendanceRecords.attendanceDate,
        createdAt: attendanceRecords.createdAt,
        updatedAt: attendanceRecords.updatedAt,
        employeeNo: employees.employeeNo,
        employeeName: employees.fullName,
        trainingTitle: trainingEvents.title,
      })
      .from(attendanceRecords)
      .innerJoin(employees, eq(attendanceRecords.employeeId, employees.id))
      .innerJoin(trainingEvents, eq(attendanceRecords.trainingEventId, trainingEvents.id))
      .where(
        and(
          inArray(employees.unitId, scopeUnitIds),
          employeeNotDeletedCondition(),
          trainingEventNotDeletedCondition(),
          attendanceNotDeletedCondition(),
        ),
      )
      .orderBy(desc(attendanceRecords.updatedAt))
      .limit(sourceLimit);

    const activities: Array<{
      id: string;
      kind: "employee" | "training" | "attendance";
      title: string;
      subtitle: string;
      href: string;
      createdAt: string;
    }> = [];

    for (const row of employeeRows) {
      const recentlyCreated = isRecentlyCreated(row.createdAt, row.updatedAt);
      activities.push({
        id: `employee-${row.id}`,
        kind: "employee",
        title: recentlyCreated
          ? `New employee profile added: ${row.fullName}`
          : `Employee profile updated: ${row.fullName}`,
        subtitle: row.employeeNo,
        href: buildPathWithQuery("/employees", {
          focusEmployeeId: row.id,
        }),
        createdAt: toIsoTimestamp(row.updatedAt ?? row.createdAt),
      });
    }

    for (const row of trainingRows) {
      let title = `Training event updated: ${row.title}`;
      if (row.workflowStatus === "submitted") {
        title = `Training submitted for review: ${row.title}`;
      } else if (row.workflowStatus === "approved") {
        title = `Training approved: ${row.title}`;
      } else if (row.workflowStatus === "locked") {
        title = `Training locked: ${row.title}`;
      } else if (isRecentlyCreated(row.createdAt, row.updatedAt)) {
        title = `New training event created: ${row.title}`;
      }

      activities.push({
        id: `training-${row.id}`,
        kind: "training",
        title,
        subtitle: `Start date: ${row.startDate}`,
        href: buildPathWithQuery("/trainings", {
          focusTrainingId: row.id,
        }),
        createdAt: toIsoTimestamp(row.updatedAt ?? row.createdAt),
      });
    }

    for (const row of attendanceRows) {
      let title = "Attendance record updated";
      if (row.workflowStatus === "submitted") {
        title = "Attendance report submitted for review";
      } else if (row.workflowStatus === "approved") {
        title = "Attendance report approved";
      } else if (row.workflowStatus === "locked") {
        title = "Attendance record locked";
      } else if (isRecentlyCreated(row.createdAt, row.updatedAt)) {
        title = "New attendance record added";
      }

      activities.push({
        id: `attendance-${row.id}`,
        kind: "attendance",
        title,
        subtitle: `${row.employeeName} (${row.employeeNo}) - ${row.trainingTitle}`,
        href: buildPathWithQuery("/attendance", {
          trainingEventId: row.trainingEventId,
          focusAttendanceId: row.id,
        }),
        createdAt: toIsoTimestamp(row.updatedAt ?? row.createdAt),
      });
    }

    activities.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    res.json({ activities: activities.slice(0, limit) });
  });

  api.get("/search", async (req, res) => {
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }

    const query = parsed.data.q?.trim();
    if (!query || query.length < 2) {
      return res.json({ results: [] });
    }

    const scopeUnitIds = await getScopedUnitIds(req.user!);
    if (scopeUnitIds.length === 0) {
      return res.json({ results: [] });
    }

    const likeTerm = `%${query}%`;

    const employeeRows = await db
      .select({
        id: employees.id,
        employeeNo: employees.employeeNo,
        fullName: employees.fullName,
      })
      .from(employees)
      .where(
        and(
          inArray(employees.unitId, scopeUnitIds),
          employeeNotDeletedCondition(),
          or(
            ilike(employees.fullName, likeTerm),
            ilike(employees.employeeNo, likeTerm),
          )!,
        ),
      )
      .orderBy(asc(employees.fullName))
      .limit(6);

    const trainingRows = await db
      .select({
        id: trainingEvents.id,
        title: trainingEvents.title,
        category: trainingEvents.category,
        provider: trainingEvents.provider,
      })
      .from(trainingEvents)
      .where(
        and(
          inArray(trainingEvents.ownerUnitId, scopeUnitIds),
          trainingEventNotDeletedCondition(),
          or(
            ilike(trainingEvents.title, likeTerm),
            ilike(trainingEvents.category, likeTerm),
            ilike(trainingEvents.provider, likeTerm),
          )!,
        ),
      )
      .orderBy(desc(trainingEvents.updatedAt))
      .limit(6);

    const attachmentRows = await db
      .select({
        id: attachments.id,
        fileName: attachments.fileName,
        entityType: attachments.entityType,
        entityId: attachments.entityId,
      })
      .from(attachments)
      .where(ilike(attachments.fileName, likeTerm))
      .orderBy(desc(attachments.uploadedAt))
      .limit(24);

    const scopedAttachments = (
      await Promise.all(
        attachmentRows.map(async (row) => ({
          row,
          allowed: await isEntityInScope(row.entityType, row.entityId, scopeUnitIds),
        })),
      )
    )
      .filter((item) => item.allowed)
      .map((item) => item.row)
      .slice(0, 6);

    const attendanceAttachmentIds = scopedAttachments
      .filter((row) => row.entityType === "attendance_record")
      .map((row) => row.entityId);

    const attendanceAttachmentRows =
      attendanceAttachmentIds.length === 0
        ? []
        : await db
            .select({
              id: attendanceRecords.id,
              trainingEventId: attendanceRecords.trainingEventId,
            })
            .from(attendanceRecords)
            .where(
              and(
                inArray(attendanceRecords.id, attendanceAttachmentIds),
                attendanceNotDeletedCondition(),
              ),
            );

    const attendanceTrainingEventById = new Map(
      attendanceAttachmentRows.map((row) => [row.id, row.trainingEventId]),
    );

    const results = [
      ...employeeRows.map((row) => ({
        id: `employee-${row.id}`,
        type: "employee",
        title: row.fullName,
        subtitle: row.employeeNo,
        href: buildPathWithQuery("/employees", {
          focusEmployeeId: row.id,
        }),
      })),
      ...trainingRows.map((row) => ({
        id: `training-${row.id}`,
        type: "training",
        title: row.title,
        subtitle: row.category || row.provider || "Training event",
        href: buildPathWithQuery("/trainings", {
          focusTrainingId: row.id,
        }),
      })),
      ...scopedAttachments.map((row) => ({
        id: `document-${row.id}`,
        type: "document",
        title: row.fileName,
        subtitle: "Attachment",
        href:
          row.entityType === "attendance_record"
            ? buildPathWithQuery("/attendance", {
                trainingEventId: attendanceTrainingEventById.get(row.entityId),
                focusAttendanceId: row.entityId,
              })
            : row.entityType === "training_event"
              ? buildPathWithQuery("/trainings", {
                  focusTrainingId: row.entityId,
                })
              : buildPathWithQuery("/employees", {
                  focusEmployeeId: row.entityId,
                }),
      })),
    ];

    res.json({ results: results.slice(0, 15) });
  });

  api.get("/reports/hours-by-employee", async (req, res) => {
    const parsed = reportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const requestedPage = parsed.data.page ?? 1;
    const scopeUnitIds = await getScopedUnitIds(req.user!);
    if (scopeUnitIds.length === 0) {
      return res.json({
        rows: [],
        pagination: {
          page: requestedPage,
          pageSize: REPORT_PAGE_SIZE,
          total: 0,
          totalPages: 1,
        },
      });
    }
    let allowedUnits = scopeUnitIds;
    if (parsed.data.unitId) {
      if (!scopeUnitIds.includes(parsed.data.unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      const includeDescendants = parsed.data.includeChildren !== "false";
      allowedUnits =
        includeDescendants
          ? await getDescendantUnits(parsed.data.unitId, scopeUnitIds)
          : [parsed.data.unitId];
    }

    const filters = [
      inArray(employees.unitId, allowedUnits),
      employeeNotDeletedCondition(),
      inArray(attendanceRecords.workflowStatus, ["approved", "locked"]),
      attendanceNotDeletedCondition(),
    ];
    if (parsed.data.from) {
      filters.push(gte(attendanceRecords.attendanceDate, parsed.data.from));
    }
    if (parsed.data.to) {
      filters.push(lte(attendanceRecords.attendanceDate, parsed.data.to));
    }

    const rows = await db
      .select({
        employeeId: employees.id,
        employeeNo: employees.employeeNo,
        fullName: employees.fullName,
        unitId: employees.unitId,
        totalHours: sql<number>`coalesce(sum(${attendanceRecords.hoursCredited}), 0)`,
      })
      .from(attendanceRecords)
      .innerJoin(employees, eq(attendanceRecords.employeeId, employees.id))
      .where(and(...filters))
      .groupBy(employees.id, employees.employeeNo, employees.fullName, employees.unitId)
      .orderBy(asc(employees.fullName));

    if (parsed.data.format === "csv") {
      const csv = toCsv(rows);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=\"hours-by-employee.csv\"");
      return res.send(csv);
    }

    res.json(paginateReportRows(rows, requestedPage));
  });

  api.get("/reports/hours-by-unit", async (req, res) => {
    const parsed = reportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const requestedPage = parsed.data.page ?? 1;
    const scopeUnitIds = await getScopedUnitIds(req.user!);
    if (scopeUnitIds.length === 0) {
      return res.json({
        rows: [],
        pagination: {
          page: requestedPage,
          pageSize: REPORT_PAGE_SIZE,
          total: 0,
          totalPages: 1,
        },
      });
    }
    let allowedUnits = scopeUnitIds;
    if (parsed.data.unitId) {
      if (!scopeUnitIds.includes(parsed.data.unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      const includeDescendants = parsed.data.includeChildren !== "false";
      allowedUnits =
        includeDescendants
          ? await getDescendantUnits(parsed.data.unitId, scopeUnitIds)
          : [parsed.data.unitId];
    }

    const filters = [
      inArray(employees.unitId, allowedUnits),
      employeeNotDeletedCondition(),
      inArray(attendanceRecords.workflowStatus, ["approved", "locked"]),
      attendanceNotDeletedCondition(),
    ];
    if (parsed.data.from) {
      filters.push(gte(attendanceRecords.attendanceDate, parsed.data.from));
    }
    if (parsed.data.to) {
      filters.push(lte(attendanceRecords.attendanceDate, parsed.data.to));
    }

    const baseRows = await db
      .select({
        unitId: employees.unitId,
        totalHours: sql<number>`coalesce(sum(${attendanceRecords.hoursCredited}), 0)`,
      })
      .from(attendanceRecords)
      .innerJoin(employees, eq(attendanceRecords.employeeId, employees.id))
      .where(and(...filters))
      .groupBy(employees.unitId);

    const unitRows = await db
      .select({ id: units.id, name: units.name, parentUnitId: units.parentUnitId })
      .from(units)
      .where(inArray(units.id, allowedUnits));

    const baseMap = new Map<string, number>();
    for (const row of baseRows) {
      baseMap.set(row.unitId, Number(row.totalHours));
    }
    const parentMap = new Map<string, string | null>();
    for (const unit of unitRows) {
      parentMap.set(unit.id, unit.parentUnitId ?? null);
    }
    const totals = new Map<string, number>(baseMap);
    for (const [unitId, hours] of baseMap.entries()) {
      let parent = parentMap.get(unitId);
      while (parent) {
        totals.set(parent, (totals.get(parent) || 0) + hours);
        parent = parentMap.get(parent) || null;
      }
    }

    const rows = unitRows.map((unit) => ({
      unitId: unit.id,
      unitName: unit.name,
      parentUnitId: unit.parentUnitId,
      totalHours: totals.get(unit.id) || 0,
    }));

    if (parsed.data.format === "csv") {
      const csv = toCsv(rows);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=\"hours-by-unit.csv\"");
      return res.send(csv);
    }

    res.json(paginateReportRows(rows, requestedPage));
  });

  api.get("/reports/compliance", async (req, res) => {
    const parsed = reportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const requestedPage = parsed.data.page ?? 1;
    const scopeUnitIds = await getScopedUnitIds(req.user!);
    if (scopeUnitIds.length === 0) {
      return res.json({
        rows: [],
        pagination: {
          page: requestedPage,
          pageSize: REPORT_PAGE_SIZE,
          total: 0,
          totalPages: 1,
        },
      });
    }
    let allowedUnits = scopeUnitIds;
    if (parsed.data.unitId) {
      if (!scopeUnitIds.includes(parsed.data.unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      const includeDescendants = parsed.data.includeChildren !== "false";
      allowedUnits =
        includeDescendants
          ? await getDescendantUnits(parsed.data.unitId, scopeUnitIds)
          : [parsed.data.unitId];
    }

    const mandatoryFilters = [eq(trainingEvents.isMandatory, true), trainingEventNotDeletedCondition()];
    if (parsed.data.from) {
      mandatoryFilters.push(gte(trainingEvents.startDate, parsed.data.from));
    }
    if (parsed.data.to) {
      mandatoryFilters.push(lte(trainingEvents.endDate, parsed.data.to));
    }

    const mandatoryEvents = await db
      .select({
        id: trainingEvents.id,
        ownerUnitId: trainingEvents.ownerUnitId,
        visibilityScope: trainingEvents.visibilityScope,
      })
      .from(trainingEvents)
      .where(and(...mandatoryFilters));
    const parentMap = await getUnitParentMap();
    const visibleMandatoryEvents = mandatoryEvents.filter((event) =>
      isTrainingEventVisibleToScope(event, allowedUnits, parentMap),
    );
    const mandatoryIds = visibleMandatoryEvents.map((event) => event.id);

    const employeeRows = await db
      .select({
        employeeId: employees.id,
        employeeNo: employees.employeeNo,
        fullName: employees.fullName,
        unitId: employees.unitId,
      })
      .from(employees)
      .where(and(inArray(employees.unitId, allowedUnits), employeeNotDeletedCondition()));

    const applicableMandatoryIdsByEmployee = new Map<string, Set<string>>();
    for (const employee of employeeRows) {
      const applicable = new Set<string>();
      for (const event of visibleMandatoryEvents) {
        if (isTrainingEventVisibleToUnit(event, employee.unitId, parentMap)) {
          applicable.add(event.id);
        }
      }
      applicableMandatoryIdsByEmployee.set(employee.employeeId, applicable);
    }

    const completedMap = new Map<string, Set<string>>();
    if (mandatoryIds.length > 0 && employeeRows.length > 0) {
      const attendanceRows = await db
        .select({
          employeeId: attendanceRecords.employeeId,
          trainingEventId: attendanceRecords.trainingEventId,
        })
        .from(attendanceRecords)
        .where(
          and(
            inArray(attendanceRecords.employeeId, employeeRows.map((row) => row.employeeId)),
            inArray(attendanceRecords.trainingEventId, mandatoryIds),
            inArray(attendanceRecords.workflowStatus, ["approved", "locked"]),
            attendanceNotDeletedCondition(),
          ),
        )
        .groupBy(attendanceRecords.employeeId, attendanceRecords.trainingEventId);
      for (const row of attendanceRows) {
        const applicableMandatoryIds = applicableMandatoryIdsByEmployee.get(row.employeeId);
        if (!applicableMandatoryIds || !applicableMandatoryIds.has(row.trainingEventId)) {
          continue;
        }
        const completed = completedMap.get(row.employeeId) || new Set<string>();
        completed.add(row.trainingEventId);
        completedMap.set(row.employeeId, completed);
      }
    }

    const rows = employeeRows.map((employee) => {
      const applicableMandatory = applicableMandatoryIdsByEmployee.get(employee.employeeId);
      const totalMandatory = applicableMandatory ? applicableMandatory.size : 0;
      const completed = completedMap.get(employee.employeeId)?.size || 0;
      const compliance =
        totalMandatory === 0 ? 100 : Math.round((completed / totalMandatory) * 100);
      return {
        employeeId: employee.employeeId,
        employeeNo: employee.employeeNo,
        fullName: employee.fullName,
        unitId: employee.unitId,
        totalMandatory,
        completedMandatory: completed,
        compliancePercent: compliance,
      };
    });

    if (parsed.data.format === "csv") {
      const csv = toCsv(rows);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=\"compliance.csv\"");
      return res.send(csv);
    }

    res.json(paginateReportRows(rows, requestedPage));
  });

  api.delete(
    "/approvals/pending",
    requireRole(["super_admin"]),
    async (req, res) => {
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      if (scopeUnitIds.length === 0) {
        return res.json({ trainingDeleted: 0, attendanceDeleted: 0 });
      }

      const deletedAt = new Date();
      const deleteReason = "Temporary bulk delete from Approvals Pending Review.";
      const trainingDeleted = await db
        .update(trainingEvents)
        .set({
          deletedAt,
          deletedBy: req.user!.id,
          deleteReason,
          updatedAt: deletedAt,
          updatedBy: req.user!.id,
        })
        .where(
          and(
            inArray(trainingEvents.ownerUnitId, scopeUnitIds),
            eq(trainingEvents.workflowStatus, "submitted"),
            trainingEventNotDeletedCondition(),
          ),
        )
        .returning({ id: trainingEvents.id });

      const scopedEmployeeRows = await db
        .select({ id: employees.id })
        .from(employees)
        .where(and(inArray(employees.unitId, scopeUnitIds), employeeNotDeletedCondition()));
      const scopedEmployeeIds = scopedEmployeeRows.map((row) => row.id);
      const attendanceDeleted =
        scopedEmployeeIds.length === 0
          ? []
          : await db
              .update(attendanceRecords)
              .set({
                deletedAt,
                deletedBy: req.user!.id,
                deleteReason,
                updatedAt: deletedAt,
                updatedBy: req.user!.id,
              })
              .where(
                and(
                  inArray(attendanceRecords.employeeId, scopedEmployeeIds),
                  eq(attendanceRecords.workflowStatus, "submitted"),
                  attendanceNotDeletedCondition(),
                ),
              )
              .returning({ id: attendanceRecords.id });

      await logAudit({
        actorUserId: req.user!.id,
        action: "approvals.pending.bulk_delete",
        entityType: "approvals_queue",
        entityId: null,
        afterJson: {
          trainingDeleted: trainingDeleted.length,
          attendanceDeleted: attendanceDeleted.length,
        },
        ip: req.ip,
      });

      res.json({
        trainingDeleted: trainingDeleted.length,
        attendanceDeleted: attendanceDeleted.length,
      });
    },
  );

  api.get(
    "/approvals",
    requireRole(["super_admin", "hr_qa_approver"]),
    async (req, res) => {
      const scopeUnitIds = await getScopedUnitIds(req.user!);
      const trainingSubmitted = await db
        .select()
        .from(trainingEvents)
        .where(
          and(
            inArray(trainingEvents.ownerUnitId, scopeUnitIds),
            trainingEventNotDeletedCondition(),
            eq(trainingEvents.workflowStatus, "submitted"),
          ),
        );
      const trainingApproved = await db
        .select()
        .from(trainingEvents)
        .where(
          and(
            inArray(trainingEvents.ownerUnitId, scopeUnitIds),
            trainingEventNotDeletedCondition(),
            eq(trainingEvents.workflowStatus, "approved"),
          ),
        );
      const trainingLocked = await db
        .select()
        .from(trainingEvents)
        .where(
          and(
            inArray(trainingEvents.ownerUnitId, scopeUnitIds),
            trainingEventNotDeletedCondition(),
            eq(trainingEvents.workflowStatus, "locked"),
          ),
        );
      const employeeRows = await db
        .select({ id: employees.id })
        .from(employees)
        .where(and(inArray(employees.unitId, scopeUnitIds), employeeNotDeletedCondition()));
      const employeeIds = employeeRows.map((row) => row.id);
      const attendanceSubmitted =
        employeeIds.length === 0
          ? []
          : await db
              .select()
              .from(attendanceRecords)
              .where(
                and(
                  inArray(attendanceRecords.employeeId, employeeIds),
                  attendanceNotDeletedCondition(),
                  eq(attendanceRecords.workflowStatus, "submitted"),
                ),
              );

      const enrichAttendanceWithImportMeta = async (
        rows: Array<typeof attendanceRecords.$inferSelect>,
      ) => {
        const toAttendanceDateKey = (value: string | Date | null | undefined) => {
          if (!value) return "";
          if (value instanceof Date) {
            return value.toISOString().slice(0, 10);
          }
          return value.slice(0, 10);
        };

        if (rows.length === 0) {
          return [];
        }

        const trainingEventIds = Array.from(
          new Set(rows.map((row) => row.trainingEventId)),
        );
        const committedBatches =
          trainingEventIds.length === 0
            ? []
            : await db
                .select({
                  id: attendanceImportBatches.id,
                  trainingEventId: attendanceImportBatches.trainingEventId,
                  fileName: attendanceImportBatches.fileName,
                  createdAt: attendanceImportBatches.createdAt,
                })
                .from(attendanceImportBatches)
                .where(
                  and(
                    inArray(attendanceImportBatches.trainingEventId, trainingEventIds),
                    eq(attendanceImportBatches.status, "committed"),
                  ),
                );

        if (committedBatches.length === 0) {
          return rows.map((row) => ({
            ...row,
            importBatchId: null,
            importBatchFileName: null,
            importBatchCreatedAt: null,
          }));
        }

        const batchById = new Map(committedBatches.map((batch) => [batch.id, batch]));
        const committedBatchIds = committedBatches.map((batch) => batch.id);
        const importRows =
          committedBatchIds.length === 0
            ? []
            : await db
                .select({
                  batchId: attendanceImportRows.batchId,
                  resolvedEmployeeId: attendanceImportRows.resolvedEmployeeId,
                  rawRowJson: attendanceImportRows.rawRowJson,
                })
                .from(attendanceImportRows)
                .where(
                  and(
                    inArray(attendanceImportRows.batchId, committedBatchIds),
                    eq(attendanceImportRows.matchStatus, "matched"),
                  ),
                );

        const importMetaByAttendanceKey = new Map<
          string,
          { id: string; fileName: string; createdAt: Date | null }
        >();

        for (const importRow of importRows) {
          if (!importRow.resolvedEmployeeId) continue;
          const batch = batchById.get(importRow.batchId);
          if (!batch) continue;
          const raw = importRow.rawRowJson as Record<string, string>;
          const rawDateValue =
            raw.Date ||
            raw.attendance_date ||
            raw.attendanceDate ||
            raw["Attendance Date"] ||
            raw["attendance date"];
          const parsedDates = parseAttendanceCsvDates(rawDateValue);
          if (parsedDates.error || parsedDates.dates.length === 0) continue;

          for (const attendanceDate of parsedDates.dates) {
            const attendanceKey = `${batch.trainingEventId}::${importRow.resolvedEmployeeId}::${toAttendanceDateKey(attendanceDate)}`;
            const existing = importMetaByAttendanceKey.get(attendanceKey);
            const existingTime = existing?.createdAt ? new Date(existing.createdAt).getTime() : 0;
            const nextTime = batch.createdAt ? new Date(batch.createdAt).getTime() : 0;
            if (!existing || nextTime >= existingTime) {
              importMetaByAttendanceKey.set(attendanceKey, {
                id: batch.id,
                fileName: batch.fileName,
                createdAt: batch.createdAt,
              });
            }
          }
        }

        return rows.map((row) => {
          const attendanceKey = `${row.trainingEventId}::${row.employeeId}::${toAttendanceDateKey(row.attendanceDate)}`;
          const importMeta = importMetaByAttendanceKey.get(attendanceKey);
          return {
            ...row,
            importBatchId: importMeta?.id ?? null,
            importBatchFileName: importMeta?.fileName ?? null,
            importBatchCreatedAt: importMeta?.createdAt ?? null,
          };
        });
      };

      const attendanceSubmittedWithMeta =
        await enrichAttendanceWithImportMeta(attendanceSubmitted);
      const attendanceApproved =
        employeeIds.length === 0
          ? []
          : await db
              .select()
              .from(attendanceRecords)
              .where(
                and(
                  inArray(attendanceRecords.employeeId, employeeIds),
                  attendanceNotDeletedCondition(),
                  eq(attendanceRecords.workflowStatus, "approved"),
                ),
              );
      const attendanceLocked =
        employeeIds.length === 0
          ? []
          : await db
              .select()
              .from(attendanceRecords)
              .where(
                and(
                  inArray(attendanceRecords.employeeId, employeeIds),
                  attendanceNotDeletedCondition(),
                  eq(attendanceRecords.workflowStatus, "locked"),
                ),
              );
      res.json({
        training: {
          submitted: trainingSubmitted,
          approved: trainingApproved,
          locked: trainingLocked,
        },
        attendance: {
          submitted: attendanceSubmittedWithMeta,
          approved: attendanceApproved,
          locked: attendanceLocked,
        },
      });
    },
  );

  api.get(
    "/audit",
    requireRole([
      "super_admin",
      "hr_qa_approver",
      "unit_head",
      "encoder",
      "viewer_auditor",
    ]),
    async (req, res) => {
      const querySchema = z.object({
        entityType: z.string().optional(),
        entityId: z.string().uuid().optional(),
      });
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const filters = [];
      if (parsed.data.entityType) {
        filters.push(eq(auditLogs.entityType, parsed.data.entityType));
      }
      if (parsed.data.entityId) {
        filters.push(eq(auditLogs.entityId, parsed.data.entityId));
      }
      const rows = await db
        .select()
        .from(auditLogs)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(auditLogs.createdAt));

      if (req.user!.role === "super_admin" || req.user!.role === "hr_qa_approver") {
        return res.json({ logs: rows });
      }

      const scopeUnitIds = await getScopedUnitIds(req.user!);
      const scopedLogs = (
        await Promise.all(
          rows.map(async (row) => ({
            row,
            allowed: await canUserViewAuditLog(row, req.user!, scopeUnitIds),
          })),
        )
      )
        .filter((entry) => entry.allowed)
        .map((entry) => entry.row);

      res.json({ logs: scopedLogs });
    },
  );

  app.use("/api", api);
  return httpServer;
}








