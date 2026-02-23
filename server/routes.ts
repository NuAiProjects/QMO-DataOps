import type { Express } from "express";
import express from "express";
import { type Server } from "http";
import path from "path";
import fs from "fs/promises";
import { createReadStream } from "fs";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { and, asc, desc, eq, ilike, inArray, or, sql, gte, lte } from "drizzle-orm";
import { z } from "zod";
import { configureAuth } from "./auth";
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
  employeeNo: z.string().min(1),
  fullName: z.string().min(1),
  email: z.string().email().optional().nullable(),
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

const requiredAttendanceCsvHeaders = ["No", "Participants", "Title", "Date"] as const;
const requiredEmployeeCsvHeaders = ["Employee No", "Full Name", "Department"] as const;

function normalizeCsvText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
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

  const slashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (slashMatch) {
    return toIsoDate(Number(slashMatch[3]), Number(slashMatch[1]), Number(slashMatch[2]));
  }

  const dashMatch = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(value);
  if (dashMatch) {
    return toIsoDate(Number(dashMatch[3]), Number(dashMatch[1]), Number(dashMatch[2]));
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

function isEditableStatus(status: string) {
  return status === "draft" || status === "returned";
}

function isSubmittedStatus(status: string) {
  return status === "submitted";
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
      .where(eq(trainingEvents.id, entityId))
      .limit(1);
    return !!row && scopeUnitIds.includes(row.ownerUnitId);
  }
  if (entityType === "employee") {
    const [row] = await db
      .select({ unitId: employees.unitId })
      .from(employees)
      .where(eq(employees.id, entityId))
      .limit(1);
    return !!row && scopeUnitIds.includes(row.unitId);
  }
  const [attendanceRow] = await db
    .select({ employeeId: attendanceRecords.employeeId })
    .from(attendanceRecords)
    .where(eq(attendanceRecords.id, entityId))
    .limit(1);
  if (!attendanceRow) return false;
  const [employeeRow] = await db
    .select({ unitId: employees.unitId })
    .from(employees)
    .where(eq(employees.id, attendanceRow.employeeId))
    .limit(1);
  return !!employeeRow && scopeUnitIds.includes(employeeRow.unitId);
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

const reportQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  unitId: z.string().uuid().optional(),
  includeChildren: z.string().optional(),
  format: z.enum(["csv"]).optional(),
});

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

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  await configureAuth(app);

  const api = express.Router();
  api.use(requireAuth);

  api.get("/units", async (req, res) => {
    const scopeUnits = await getUnitsInScopeForUser(req.user);
    res.json({ units: scopeUnits });
  });

  api.post("/units", requireRole(["super_admin"]), async (req, res) => {
    const parsed = unitInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const [unit] = await db.insert(units).values(parsed.data).returning();
    await logAudit({
      actorUserId: req.user.id,
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
    const unitId = req.params.id;
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
      actorUserId: req.user.id,
      action: "unit.update",
      entityType: "unit",
      entityId: unitId,
      beforeJson: existing,
      afterJson: updated,
      ip: req.ip,
    });
    res.json({ unit: updated });
  });

  api.get("/users", requireRole(["super_admin"]), async (_req, res) => {
    const rows = await db.select().from(users).orderBy(asc(users.fullName));
    const userUnitRows = await db.select().from(userUnits);
    const unitMap = userUnitRows.reduce<Record<string, string[]>>((acc, row) => {
      acc[row.userId] = acc[row.userId] || [];
      acc[row.userId].push(row.unitId);
      return acc;
    }, {});
    res.json({
      users: rows.map((user) => ({ ...user, unitIds: unitMap[user.id] || [] })),
    });
  });

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
      actorUserId: req.user.id,
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
    const userId = req.params.id;
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
      actorUserId: req.user.id,
      action: "user.update",
      entityType: "user",
      entityId: userId,
      beforeJson: existing,
      afterJson: { ...updated, unitIds },
      ip: req.ip,
    });
    res.json({ user: updated });
  });

  api.get("/employees", async (req, res) => {
    const scopeUnitIds = await getScopedUnitIds(req.user);
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

    const filters = [inArray(employees.unitId, allowedUnits)];
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
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    async (req, res) => {
      const parsed = employeeInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
      if (!scopeUnitIds.includes(parsed.data.unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      const [created] = await db
        .insert(employees)
        .values({
          ...parsed.data,
          employmentStatus: parsed.data.employmentStatus ?? "active",
        })
        .returning();
      await logAudit({
        actorUserId: req.user.id,
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
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
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
        }) as Record<string, string>[];
      } catch {
        return res.status(400).json({ message: "Invalid CSV format." });
      }

      const hasRequiredHeaders = requiredEmployeeCsvHeaders.every((header) =>
        parsedHeaders.includes(header),
      );
      if (!hasRequiredHeaders) {
        return res.status(400).json({
          message: "Invalid CSV schema. Required columns are: Employee No, Full Name, Department.",
        });
      }

      if (records.length === 0) {
        return res.status(400).json({ message: "CSV has no data rows." });
      }

      const scopeUnitIds = await getScopedUnitIds(req.user);
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
      for (const unit of scopedUnits) {
        unitLookup.set(normalizeCsvText(unit.id), unit.id);
        unitLookup.set(normalizeCsvText(unit.name), unit.id);
        if (unit.code) {
          unitLookup.set(normalizeCsvText(unit.code), unit.id);
        }
      }

      const employeeNos = records
        .map((row) =>
          getCsvRowValue(row, ["Employee No", "employeeNo", "employee_no", "No", "ID"]),
        )
        .filter((value) => value.length > 0);

      const existingRows =
        employeeNos.length === 0
          ? []
          : await db
              .select({
                id: employees.id,
                employeeNo: employees.employeeNo,
                unitId: employees.unitId,
              })
              .from(employees)
              .where(inArray(employees.employeeNo, employeeNos));

      const existingByEmployeeNo = new Map(
        existingRows.map((row) => [normalizeCsvText(row.employeeNo), row]),
      );

      const summary = {
        total: records.length,
        created: 0,
        updated: 0,
        invalid: 0,
      };
      const errors: Array<{ row: number; employeeNo: string; message: string }> = [];

      for (let index = 0; index < records.length; index += 1) {
        const row = records[index];
        const employeeNo = getCsvRowValue(row, [
          "Employee No",
          "employeeNo",
          "employee_no",
          "No",
          "ID",
        ]);
        const fullName = getCsvRowValue(row, ["Full Name", "fullName", "full_name", "Name"]);
        const department = getCsvRowValue(row, [
          "Department",
          "department",
          "Unit",
          "Unit Name",
          "unitId",
          "Unit ID",
        ]);
        const email = getCsvRowValue(row, ["Email", "email"]);
        const position = getCsvRowValue(row, ["Position", "position"]);
        const employmentStatusRaw = getCsvRowValue(row, [
          "Employment Status",
          "employmentStatus",
          "Status",
          "status",
        ]);

        if (!employeeNo || !fullName || !department) {
          summary.invalid += 1;
          errors.push({
            row: index + 2,
            employeeNo: employeeNo || "",
            message: "Employee No, Full Name, and Department are required.",
          });
          continue;
        }

        const unitId = unitLookup.get(normalizeCsvText(department));
        if (!unitId) {
          summary.invalid += 1;
          errors.push({
            row: index + 2,
            employeeNo,
            message: "Department not found or out of scope.",
          });
          continue;
        }

        if (email) {
          const isEmailValid = z.string().email().safeParse(email).success;
          if (!isEmailValid) {
            summary.invalid += 1;
            errors.push({
              row: index + 2,
              employeeNo,
              message: "Invalid email format.",
            });
            continue;
          }
        }

        let employmentStatus: "active" | "inactive" = "active";
        if (employmentStatusRaw) {
          const normalizedStatus = normalizeCsvText(employmentStatusRaw);
          if (normalizedStatus !== "active" && normalizedStatus !== "inactive") {
            summary.invalid += 1;
            errors.push({
              row: index + 2,
              employeeNo,
              message: "Employment Status must be active or inactive.",
            });
            continue;
          }
          employmentStatus = normalizedStatus;
        }

        const existing = existingByEmployeeNo.get(normalizeCsvText(employeeNo));
        if (existing) {
          if (!scopeUnitIds.includes(existing.unitId)) {
            summary.invalid += 1;
            errors.push({
              row: index + 2,
              employeeNo,
              message: "Employee exists but is outside your unit scope.",
            });
            continue;
          }
          const [updated] = await db
            .update(employees)
            .set({
              fullName,
              email: email || null,
              unitId,
              position: position || null,
              employmentStatus,
              updatedAt: new Date(),
            })
            .where(eq(employees.id, existing.id))
            .returning();
          existingByEmployeeNo.set(normalizeCsvText(employeeNo), {
            id: updated.id,
            employeeNo: updated.employeeNo,
            unitId: updated.unitId,
          });
          summary.updated += 1;
          continue;
        }

        try {
          const [created] = await db
            .insert(employees)
            .values({
              employeeNo,
              fullName,
              email: email || null,
              unitId,
              position: position || null,
              employmentStatus,
              hireDate: null,
            })
            .returning();
          existingByEmployeeNo.set(normalizeCsvText(created.employeeNo), {
            id: created.id,
            employeeNo: created.employeeNo,
            unitId: created.unitId,
          });
          summary.created += 1;
        } catch {
          summary.invalid += 1;
          errors.push({
            row: index + 2,
            employeeNo,
            message: "Unable to create employee row.",
          });
        }
      }

      await logAudit({
        actorUserId: req.user.id,
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
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    async (req, res) => {
      const parsed = employeeInputSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const employeeId = req.params.id;
      const [existing] = await db
        .select()
        .from(employees)
        .where(eq(employees.id, employeeId))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Employee not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
      if (!scopeUnitIds.includes(existing.unitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (parsed.data.unitId && !scopeUnitIds.includes(parsed.data.unitId)) {
        return res.status(403).json({ message: "Target unit out of scope." });
      }
      const [updated] = await db
        .update(employees)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(eq(employees.id, employeeId))
        .returning();
      await logAudit({
        actorUserId: req.user.id,
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

  api.get("/training-events", async (req, res) => {
    const scopeUnitIds = await getScopedUnitIds(req.user);
    if (scopeUnitIds.length === 0) {
      return res.json({ trainingEvents: [] });
    }
    const querySchema = z.object({
      unitId: z.string().uuid().optional(),
      includeChildren: z.string().optional(),
      status: z.string().optional(),
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
    const filters = [inArray(trainingEvents.ownerUnitId, allowedUnits)];
    if (status) {
      filters.push(eq(trainingEvents.workflowStatus, status));
    }
    const rows = await db
      .select()
      .from(trainingEvents)
      .where(and(...filters))
      .orderBy(desc(trainingEvents.startDate));
    res.json({ trainingEvents: rows });
  });

  api.post(
    "/training-events",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    async (req, res) => {
      const parsed = trainingEventInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
      if (!scopeUnitIds.includes(parsed.data.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      const [created] = await db
        .insert(trainingEvents)
        .values({
          ...parsed.data,
          hours: parsed.data.hours.toString(),
          visibilityScope: parsed.data.visibilityScope ?? "unit",
          isMandatory: parsed.data.isMandatory ?? false,
          createdBy: req.user.id,
          updatedBy: req.user.id,
        })
        .returning();
      await logAudit({
        actorUserId: req.user.id,
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
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    async (req, res) => {
      const parsed = trainingEventInputSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const eventId = req.params.id;
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(eq(trainingEvents.id, eventId))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
      if (!scopeUnitIds.includes(existing.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      if (parsed.data.ownerUnitId && !scopeUnitIds.includes(parsed.data.ownerUnitId)) {
        return res.status(403).json({ message: "Target unit out of scope." });
      }
      if (!isEditableStatus(existing.workflowStatus)) {
        return res.status(400).json({ message: "Training event is not editable." });
      }
      const [updated] = await db
        .update(trainingEvents)
        .set({
          ...parsed.data,
          hours: parsed.data.hours ? parsed.data.hours.toString() : undefined,
          updatedBy: req.user.id,
          updatedAt: new Date(),
        })
        .where(eq(trainingEvents.id, eventId))
        .returning();
      await logAudit({
        actorUserId: req.user.id,
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

  api.post(
    "/training-events/:id/submit",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    async (req, res) => {
      const eventId = req.params.id;
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(eq(trainingEvents.id, eventId))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
          updatedBy: req.user.id,
          updatedAt: new Date(),
        })
        .where(eq(trainingEvents.id, eventId))
        .returning();
      await logWorkflowAction({
        entityType: "training_event",
        entityId: eventId,
        action: "submit",
        actorUserId: req.user.id,
      });
      await logAudit({
        actorUserId: req.user.id,
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
      const eventId = req.params.id;
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(eq(trainingEvents.id, eventId))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
          updatedBy: req.user.id,
          updatedAt: new Date(),
        })
        .where(eq(trainingEvents.id, eventId))
        .returning();
      await logWorkflowAction({
        entityType: "training_event",
        entityId: eventId,
        action: "return",
        actorUserId: req.user.id,
        notes: parsed.data.notes,
      });
      await logAudit({
        actorUserId: req.user.id,
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
      const eventId = req.params.id;
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(eq(trainingEvents.id, eventId))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
          updatedBy: req.user.id,
          updatedAt: new Date(),
        })
        .where(eq(trainingEvents.id, eventId))
        .returning();
      await logWorkflowAction({
        entityType: "training_event",
        entityId: eventId,
        action: "approve",
        actorUserId: req.user.id,
      });
      await logAudit({
        actorUserId: req.user.id,
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
      const eventId = req.params.id;
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(eq(trainingEvents.id, eventId))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
          updatedBy: req.user.id,
          updatedAt: new Date(),
        })
        .where(eq(trainingEvents.id, eventId))
        .returning();
      await logWorkflowAction({
        entityType: "training_event",
        entityId: eventId,
        action: "lock",
        actorUserId: req.user.id,
      });
      await logAudit({
        actorUserId: req.user.id,
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
      const eventId = req.params.id;
      const [existing] = await db
        .select()
        .from(trainingEvents)
        .where(eq(trainingEvents.id, eventId))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
          updatedBy: req.user.id,
          updatedAt: new Date(),
        })
        .where(eq(trainingEvents.id, eventId))
        .returning();
      await logWorkflowAction({
        entityType: "training_event",
        entityId: eventId,
        action: "reopen",
        actorUserId: req.user.id,
      });
      await logAudit({
        actorUserId: req.user.id,
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
    const scopeUnitIds = await getScopedUnitIds(req.user);
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
      .where(inArray(employees.unitId, allowedUnits));
    const employeeIds = employeeRows.map((row) => row.id);
    if (employeeIds.length === 0) {
      return res.json({ attendance: [] });
    }
    const filters = [inArray(attendanceRecords.employeeId, employeeIds)];
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
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    async (req, res) => {
      const parsed = attendanceInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const [employeeRow] = await db
        .select({ unitId: employees.unitId })
        .from(employees)
        .where(eq(employees.id, parsed.data.employeeId))
        .limit(1);
      if (!employeeRow) {
        return res.status(404).json({ message: "Employee not found." });
      }
      const [trainingEventRow] = await db
        .select({ ownerUnitId: trainingEvents.ownerUnitId })
        .from(trainingEvents)
        .where(eq(trainingEvents.id, parsed.data.trainingEventId))
        .limit(1);
      if (!trainingEventRow) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
          .where(eq(employees.id, parsed.data.employeeId))
          .limit(1);
        if (!targetEmployee || !scopeUnitIds.includes(targetEmployee.unitId)) {
          return res.status(403).json({ message: "Target employee out of scope." });
        }
      }
      if (parsed.data.trainingEventId) {
        const [targetEvent] = await db
          .select({ ownerUnitId: trainingEvents.ownerUnitId })
          .from(trainingEvents)
          .where(eq(trainingEvents.id, parsed.data.trainingEventId))
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
          createdBy: req.user.id,
          updatedBy: req.user.id,
        })
        .returning();
      await logAudit({
        actorUserId: req.user.id,
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
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    async (req, res) => {
      const parsed = attendanceInputSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const attendanceId = req.params.id;
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(eq(attendanceRecords.id, attendanceId))
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
        .where(eq(employees.id, existing.employeeId))
        .limit(1);
      if (!employeeRow) {
        return res.status(404).json({ message: "Employee not found." });
      }
      const [trainingEventRow] = await db
        .select({ ownerUnitId: trainingEvents.ownerUnitId })
        .from(trainingEvents)
        .where(eq(trainingEvents.id, existing.trainingEventId))
        .limit(1);
      if (!trainingEventRow) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
          updatedBy: req.user.id,
          updatedAt: new Date(),
        })
        .where(eq(attendanceRecords.id, attendanceId))
        .returning();
      await logAudit({
        actorUserId: req.user.id,
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

  api.post(
    "/attendance/:id/submit",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    async (req, res) => {
      const attendanceId = req.params.id;
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(eq(attendanceRecords.id, attendanceId))
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
          updatedBy: req.user.id,
          updatedAt: new Date(),
        })
        .where(eq(attendanceRecords.id, attendanceId))
        .returning();
      await logWorkflowAction({
        entityType: "attendance_record",
        entityId: attendanceId,
        action: "submit",
        actorUserId: req.user.id,
      });
      await logAudit({
        actorUserId: req.user.id,
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
      const attendanceId = req.params.id;
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(eq(attendanceRecords.id, attendanceId))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Attendance record not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
          updatedBy: req.user.id,
          updatedAt: new Date(),
        })
        .where(eq(attendanceRecords.id, attendanceId))
        .returning();
      await logWorkflowAction({
        entityType: "attendance_record",
        entityId: attendanceId,
        action: "return",
        actorUserId: req.user.id,
        notes: parsed.data.notes,
      });
      await logAudit({
        actorUserId: req.user.id,
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
      const attendanceId = req.params.id;
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(eq(attendanceRecords.id, attendanceId))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Attendance record not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
          updatedBy: req.user.id,
          updatedAt: new Date(),
        })
        .where(eq(attendanceRecords.id, attendanceId))
        .returning();
      await logWorkflowAction({
        entityType: "attendance_record",
        entityId: attendanceId,
        action: "approve",
        actorUserId: req.user.id,
      });
      await logAudit({
        actorUserId: req.user.id,
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
      const attendanceId = req.params.id;
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(eq(attendanceRecords.id, attendanceId))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Attendance record not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
          updatedBy: req.user.id,
          updatedAt: new Date(),
        })
        .where(eq(attendanceRecords.id, attendanceId))
        .returning();
      await logWorkflowAction({
        entityType: "attendance_record",
        entityId: attendanceId,
        action: "lock",
        actorUserId: req.user.id,
      });
      await logAudit({
        actorUserId: req.user.id,
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
      const attendanceId = req.params.id;
      const [existing] = await db
        .select()
        .from(attendanceRecords)
        .where(eq(attendanceRecords.id, attendanceId))
        .limit(1);
      if (!existing) {
        return res.status(404).json({ message: "Attendance record not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
          updatedBy: req.user.id,
          updatedAt: new Date(),
        })
        .where(eq(attendanceRecords.id, attendanceId))
        .returning();
      await logWorkflowAction({
        entityType: "attendance_record",
        entityId: attendanceId,
        action: "reopen",
        actorUserId: req.user.id,
      });
      await logAudit({
        actorUserId: req.user.id,
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
        .where(eq(trainingEvents.id, trainingEventId))
        .limit(1);
      if (!trainingEvent) {
        return res.status(404).json({ message: "Training event not found." });
      }
      if (!isImportableTrainingEventStatus(trainingEvent.workflowStatus)) {
        return res.status(400).json({
          message: "Training event status does not allow attendance import.",
        });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
      if (!scopeUnitIds.includes(trainingEvent.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
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
          message: "Invalid CSV schema. Required columns are: No, Participants, Title, Date.",
        });
      }

      const employeeRows = await db
        .select({
          id: employees.id,
          employeeNo: employees.employeeNo,
          fullName: employees.fullName,
        })
        .from(employees)
        .where(inArray(employees.unitId, scopeUnitIds));

      const employeeNoMap = new Map(
        employeeRows.map((row) => [normalizeCsvText(row.employeeNo), row]),
      );
      type ScopedEmployee = (typeof employeeRows)[number];
      const employeeNameMap = new Map<string, ScopedEmployee[]>();
      for (const employee of employeeRows) {
        const key = normalizeCsvText(employee.fullName);
        const list = employeeNameMap.get(key) ?? [];
        list.push(employee);
        employeeNameMap.set(key, list);
      }

      const rowsToInsert = [];
      let matched = 0;
      let unmatched = 0;
      let invalid = 0;

      for (const row of records) {
        const noValue = (row.No ?? "").trim();
        const participantsValue = (row.Participants ?? "").trim();
        const titleValue = (row.Title ?? "").trim();
        const dateValue = (row.Date ?? "").trim();

        if (!participantsValue || !titleValue || !dateValue) {
          rowsToInsert.push({
            rawRowJson: row,
            employeeNo: noValue || participantsValue || "unknown",
            matchStatus: "invalid",
            errorMessage: "Missing required values for Participants, Title, or Date.",
          });
          invalid += 1;
          continue;
        }

        const normalizedDate = normalizeAttendanceCsvDate(dateValue);
        if (!normalizedDate) {
          rowsToInsert.push({
            rawRowJson: row,
            employeeNo: noValue || participantsValue,
            matchStatus: "invalid",
            errorMessage:
              "Date must be in YYYY-MM-DD, MM/DD/YYYY, or DD-MMM-YY format.",
          });
          invalid += 1;
          continue;
        }

        let matchedEmployee = noValue
          ? employeeNoMap.get(normalizeCsvText(noValue))
          : undefined;
        if (!matchedEmployee) {
          const byName = employeeNameMap.get(normalizeCsvText(participantsValue)) ?? [];
          if (byName.length > 1) {
            rowsToInsert.push({
              rawRowJson: { ...row, Date: normalizedDate },
              employeeNo: noValue || participantsValue,
              matchStatus: "unmatched",
              errorMessage: "Multiple employees matched Participants. Resolve manually.",
            });
            unmatched += 1;
            continue;
          }
          matchedEmployee = byName[0];
        }

        if (!matchedEmployee) {
          rowsToInsert.push({
            rawRowJson: { ...row, Date: normalizedDate },
            employeeNo: noValue || participantsValue,
            matchStatus: "unmatched",
            errorMessage: "Employee not found using No or Participants.",
          });
          unmatched += 1;
          continue;
        }

        rowsToInsert.push({
          rawRowJson: { ...row, Date: normalizedDate },
          employeeNo: noValue || matchedEmployee.employeeNo,
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
          uploadedBy: req.user.id,
          fileName: req.file.originalname,
          status: unmatched > 0 || invalid > 0 ? "needs_review" : "parsed",
          summaryJson: {
            total: records.length,
            matched,
            unmatched,
            invalid,
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
        actorUserId: req.user.id,
        action: "attendance_import.create",
        entityType: "attendance_import_batch",
        entityId: batch.id,
        afterJson: { batch, summary: batch.summaryJson },
        ip: req.ip,
      });

      res.status(201).json({ batch, rows: insertedRows });
    },
  );

  api.post(
    "/attendance/import/:batchId/resolve",
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    async (req, res) => {
      const parsed = resolveRowsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const batchId = req.params.batchId;
      const [batch] = await db
        .select()
        .from(attendanceImportBatches)
        .where(eq(attendanceImportBatches.id, batchId))
        .limit(1);
      if (!batch) {
        return res.status(404).json({ message: "Batch not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
            .where(eq(employees.id, resolution.employeeId))
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
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
    async (req, res) => {
      const parsed = commitImportSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.flatten() });
      }
      const batchId = req.params.batchId;
      const [batch] = await db
        .select()
        .from(attendanceImportBatches)
        .where(eq(attendanceImportBatches.id, batchId))
        .limit(1);
      if (!batch) {
        return res.status(404).json({ message: "Batch not found." });
      }
      const [trainingEvent] = await db
        .select({
          ownerUnitId: trainingEvents.ownerUnitId,
          hours: trainingEvents.hours,
        })
        .from(trainingEvents)
        .where(eq(trainingEvents.id, batch.trainingEventId))
        .limit(1);
      if (!trainingEvent) {
        return res.status(404).json({ message: "Training event not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
      if (!scopeUnitIds.includes(trainingEvent.ownerUnitId)) {
        return res.status(403).json({ message: "Unit out of scope." });
      }
      const rows = await db
        .select()
        .from(attendanceImportRows)
        .where(eq(attendanceImportRows.batchId, batchId));

      const decisions = new Map(parsed.data.decisions?.map((d) => [d.rowId, d.action]));
      const results = { created: 0, updated: 0, skipped: 0 };

      for (const row of rows) {
        if (row.matchStatus !== "matched" || !row.resolvedEmployeeId) {
          continue;
        }
        const raw = row.rawRowJson as Record<string, string>;
        const attendanceDate =
          normalizeAttendanceCsvDate(raw.Date) ||
          raw.attendance_date ||
          raw.attendanceDate ||
          raw["Attendance Date"] ||
          raw["attendance date"];
        if (!attendanceDate) {
          continue;
        }
        const hoursCredited =
          raw.hours_credited ||
          raw.hoursCredited ||
          raw["Hours"] ||
          trainingEvent.hours.toString();
        const attendanceStatus =
          raw.attendance_status || raw.attendanceStatus || raw["Status"] || "present";
        const normalizedStatus = ["present", "absent", "partial"].includes(
          attendanceStatus.toLowerCase(),
        )
          ? attendanceStatus.toLowerCase()
          : "present";

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
          const decision = decisions.get(row.id);
          if (!decision) {
            return res.status(400).json({
              message: "Duplicate attendance found. Provide decisions for duplicates.",
            });
          }
          if (decision === "skip") {
            results.skipped += 1;
            continue;
          }
          await db
            .update(attendanceRecords)
            .set({
              hoursCredited: hoursCredited.toString(),
              attendanceStatus: normalizedStatus,
              updatedBy: req.user.id,
              updatedAt: new Date(),
            })
            .where(eq(attendanceRecords.id, existing.id));
          results.updated += 1;
        } else {
          await db.insert(attendanceRecords).values({
            trainingEventId: batch.trainingEventId,
            employeeId: row.resolvedEmployeeId,
            attendanceDate,
            hoursCredited: hoursCredited.toString(),
            attendanceStatus: normalizedStatus,
            workflowStatus: "draft",
            createdBy: req.user.id,
            updatedBy: req.user.id,
          });
          results.created += 1;
        }
      }

      await db
        .update(attendanceImportBatches)
        .set({ status: "committed" })
        .where(eq(attendanceImportBatches.id, batchId));

      await logAudit({
        actorUserId: req.user.id,
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
    requireAnyRoleOrSuperAdmin(["encoder", "unit_head"]),
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
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
          uploadedBy: req.user.id,
        })
        .returning();

      await logAudit({
        actorUserId: req.user.id,
        action: "attachment.upload",
        entityType: "attachment",
        entityId: attachment.id,
        afterJson: attachment,
        ip: req.ip,
      });

      res.status(201).json({ attachment });
    },
  );

  api.get("/attachments/:id/download", async (req, res) => {
    const attachmentId = req.params.id;
    const [attachment] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .limit(1);
    if (!attachment) {
      return res.status(404).json({ message: "Attachment not found." });
    }
    const scopeUnitIds = await getScopedUnitIds(req.user);
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
      const attachmentId = req.params.id;
      const [attachment] = await db
        .select()
        .from(attachments)
        .where(eq(attachments.id, attachmentId))
        .limit(1);
      if (!attachment) {
        return res.status(404).json({ message: "Attachment not found." });
      }
      const scopeUnitIds = await getScopedUnitIds(req.user);
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
        actorUserId: req.user.id,
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

    const scopeUnitIds = await getScopedUnitIds(req.user);
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
      .where(inArray(employees.unitId, scopeUnitIds))
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
      .where(inArray(trainingEvents.ownerUnitId, scopeUnitIds))
      .orderBy(desc(trainingEvents.updatedAt))
      .limit(sourceLimit);

    const attendanceRows = await db
      .select({
        id: attendanceRecords.id,
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
      .where(inArray(employees.unitId, scopeUnitIds))
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
        href: "/employees",
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
        href: "/trainings",
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
        href: "/attendance",
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

    const scopeUnitIds = await getScopedUnitIds(req.user);
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

    const results = [
      ...employeeRows.map((row) => ({
        id: `employee-${row.id}`,
        type: "employee",
        title: row.fullName,
        subtitle: row.employeeNo,
        href: "/employees",
      })),
      ...trainingRows.map((row) => ({
        id: `training-${row.id}`,
        type: "training",
        title: row.title,
        subtitle: row.category || row.provider || "Training event",
        href: "/trainings",
      })),
      ...scopedAttachments.map((row) => ({
        id: `document-${row.id}`,
        type: "document",
        title: row.fileName,
        subtitle: "Attachment",
        href:
          row.entityType === "attendance_record"
            ? "/attendance"
            : row.entityType === "training_event"
              ? "/trainings"
              : "/employees",
      })),
    ];

    res.json({ results: results.slice(0, 15) });
  });

  api.get("/reports/hours-by-employee", async (req, res) => {
    const parsed = reportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const scopeUnitIds = await getScopedUnitIds(req.user);
    if (scopeUnitIds.length === 0) {
      return res.json({ rows: [] });
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

    const filters = [
      inArray(employees.unitId, allowedUnits),
      inArray(attendanceRecords.workflowStatus, ["approved", "locked"]),
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

    res.json({ rows });
  });

  api.get("/reports/hours-by-unit", async (req, res) => {
    const parsed = reportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const scopeUnitIds = await getScopedUnitIds(req.user);
    if (scopeUnitIds.length === 0) {
      return res.json({ rows: [] });
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

    const filters = [
      inArray(employees.unitId, allowedUnits),
      inArray(attendanceRecords.workflowStatus, ["approved", "locked"]),
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

    res.json({ rows });
  });

  api.get("/reports/compliance", async (req, res) => {
    const parsed = reportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.flatten() });
    }
    const scopeUnitIds = await getScopedUnitIds(req.user);
    if (scopeUnitIds.length === 0) {
      return res.json({ rows: [] });
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

    const mandatoryFilters = [
      eq(trainingEvents.isMandatory, true),
      inArray(trainingEvents.ownerUnitId, allowedUnits),
    ];
    if (parsed.data.from) {
      mandatoryFilters.push(gte(trainingEvents.startDate, parsed.data.from));
    }
    if (parsed.data.to) {
      mandatoryFilters.push(lte(trainingEvents.endDate, parsed.data.to));
    }

    const mandatoryEvents = await db
      .select({ id: trainingEvents.id })
      .from(trainingEvents)
      .where(and(...mandatoryFilters));
    const mandatoryIds = mandatoryEvents.map((event) => event.id);
    const totalMandatory = mandatoryIds.length;

    const employeeRows = await db
      .select({
        employeeId: employees.id,
        employeeNo: employees.employeeNo,
        fullName: employees.fullName,
        unitId: employees.unitId,
      })
      .from(employees)
      .where(inArray(employees.unitId, allowedUnits));

    const completedMap = new Map<string, number>();
    if (mandatoryIds.length > 0 && employeeRows.length > 0) {
      const attendanceRows = await db
        .select({
          employeeId: attendanceRecords.employeeId,
          completedCount: sql<number>`count(distinct ${attendanceRecords.trainingEventId})`,
        })
        .from(attendanceRecords)
        .where(
          and(
            inArray(attendanceRecords.employeeId, employeeRows.map((row) => row.employeeId)),
            inArray(attendanceRecords.trainingEventId, mandatoryIds),
            inArray(attendanceRecords.workflowStatus, ["approved", "locked"]),
          ),
        )
        .groupBy(attendanceRecords.employeeId);
      for (const row of attendanceRows) {
        completedMap.set(row.employeeId, Number(row.completedCount));
      }
    }

    const rows = employeeRows.map((employee) => {
      const completed = completedMap.get(employee.employeeId) || 0;
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

    res.json({ rows });
  });

  api.get(
    "/approvals",
    requireRole(["super_admin", "hr_qa_approver"]),
    async (req, res) => {
      const scopeUnitIds = await getScopedUnitIds(req.user);
      const trainingSubmitted = await db
        .select()
        .from(trainingEvents)
        .where(
          and(
            inArray(trainingEvents.ownerUnitId, scopeUnitIds),
            eq(trainingEvents.workflowStatus, "submitted"),
          ),
        );
      const trainingApproved = await db
        .select()
        .from(trainingEvents)
        .where(
          and(
            inArray(trainingEvents.ownerUnitId, scopeUnitIds),
            eq(trainingEvents.workflowStatus, "approved"),
          ),
        );
      const trainingLocked = await db
        .select()
        .from(trainingEvents)
        .where(
          and(
            inArray(trainingEvents.ownerUnitId, scopeUnitIds),
            eq(trainingEvents.workflowStatus, "locked"),
          ),
        );
      const employeeRows = await db
        .select({ id: employees.id })
        .from(employees)
        .where(inArray(employees.unitId, scopeUnitIds));
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
                  eq(attendanceRecords.workflowStatus, "submitted"),
                ),
              );
      const attendanceApproved =
        employeeIds.length === 0
          ? []
          : await db
              .select()
              .from(attendanceRecords)
              .where(
                and(
                  inArray(attendanceRecords.employeeId, employeeIds),
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
          submitted: attendanceSubmitted,
          approved: attendanceApproved,
          locked: attendanceLocked,
        },
      });
    },
  );

  api.get(
    "/audit",
    requireRole(["super_admin", "hr_qa_approver"]),
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
      res.json({ logs: rows });
    },
  );

  app.use("/api", api);
  return httpServer;
}
