import { and, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import {
  auditLogs,
  attendanceRecords,
  employees,
  trainingEvents,
  type UserRole,
} from "@shared/schema";

export const AUDIT_DEFAULT_PAGE_SIZE = 25;
export const AUDIT_MAX_PAGE_SIZE = 100;
export const AUDIT_DEFAULT_LOOKBACK_DAYS = 30;
export const AUDIT_MAX_RANGE_DAYS = 180;
export const AUDIT_QUERY_TIMEOUT_MS = 3_000;

const DAY_MS = 24 * 60 * 60 * 1000;

// Audit logs are append-only and can grow quickly, so every API read must stay
// bounded by pagination and a date range before role-scoped filters are applied.

const entityLabelByType: Record<string, string> = {
  auth_session: "Authentication Session",
  user: "User Account",
  employee: "Employee Record",
  training_event: "Training Event",
  attendance_record: "Attendance Record",
  attendance_import_batch: "Attendance Import Batch",
  attachment: "File Attachment",
  unit: "Department/Unit",
};

const actionLabelByAction: Record<string, string> = {
  "auth.login.success": "User signed in successfully",
  "auth.login.failed": "Sign-in attempt failed",
  "auth.logout": "User signed out",
  "auth.password.change": "User changed own password",
  "user.create": "User account created",
  "user.update": "User account updated",
  "user.password.set": "User password set by admin",
  "employee.create": "Employee profile created",
  "employee.update": "Employee profile updated",
  "employee.delete": "Employee profile archived",
  "training_event.create": "Training event created",
  "training_event.update": "Training event updated",
  "training_event.submit": "Training event submitted for approval",
  "training_event.return": "Training event returned for revision",
  "training_event.approve": "Training event approved",
  "training_event.lock": "Training event locked",
  "training_event.reopen": "Training event reopened",
  "attendance_record.create": "Attendance record created",
  "attendance_record.update": "Attendance record updated",
  "attendance_record.submit": "Attendance record submitted for approval",
  "attendance_record.return": "Attendance record returned for revision",
  "attendance_record.approve": "Attendance record approved",
  "attendance_record.lock": "Attendance record locked",
  "attendance_record.reopen": "Attendance record reopened",
  "attendance.create": "Attendance created",
  "attendance.submit": "Attendance submitted for approval",
  "attendance.return": "Attendance returned for revision",
  "attendance.soft_delete": "Attendance archived",
  "attendance_import.create": "Attendance import created",
  "attendance_import.commit": "Attendance import committed",
  "employee.import": "Employee import completed",
  "employee.soft_delete": "Employee profile archived",
};

export type AuditQueryOptions = {
  page: number;
  pageSize: number;
  offset: number;
  entityType?: string;
  entityId?: string;
  action?: string;
  search?: string;
  from: Date;
  to: Date;
};

type ParseResult =
  | { success: true; data: AuditQueryOptions }
  | { success: false; errors: Record<string, string[]> };

function firstQueryValue(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

function parsePositiveInt(value: unknown, fallback: number) {
  const raw = firstQueryValue(value);
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseOptionalString(value: unknown, maxLength: number) {
  const raw = firstQueryValue(value);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function parseDateBoundary(value: unknown, boundary: "start" | "end") {
  const raw = firstQueryValue(value);
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  const date =
    /^\d{4}-\d{2}-\d{2}$/.test(trimmed) && boundary === "start"
      ? new Date(`${trimmed}T00:00:00.000Z`)
      : /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
        ? new Date(`${trimmed}T23:59:59.999Z`)
        : new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function normalizeForMatching(value: string) {
  return value
    .replace(/[_./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function textMatchesQuery(text: string, query: string) {
  if (text.includes(query)) return true;
  const queryTokens = query.split(" ").filter(Boolean);
  return queryTokens.length > 0 && queryTokens.every((token) => text.includes(token));
}

export function getMatchingAuditEntityTypes(input: string) {
  const normalized = normalizeForMatching(input);
  if (!normalized) return [];

  return Object.entries(entityLabelByType)
    .filter(([entityType, label]) => {
      const normalizedType = normalizeForMatching(entityType);
      const normalizedLabel = normalizeForMatching(label);
      return textMatchesQuery(normalizedType, normalized) || textMatchesQuery(normalizedLabel, normalized);
    })
    .map(([entityType]) => entityType);
}

export function getMatchingAuditActions(input: string) {
  const normalized = normalizeForMatching(input);
  if (!normalized) return [];

  return Object.entries(actionLabelByAction)
    .filter(([action, label]) => {
      const normalizedAction = normalizeForMatching(action);
      const normalizedLabel = normalizeForMatching(label);
      return textMatchesQuery(normalizedAction, normalized) || textMatchesQuery(normalizedLabel, normalized);
    })
    .map(([action]) => action);
}

export function parseAuditQueryParams(query: Record<string, unknown>, now = new Date()): ParseResult {
  const errors: Record<string, string[]> = {};
  const page = parsePositiveInt(query.page, 1);
  const pageSizeRaw = parsePositiveInt(query.pageSize ?? query.limit, AUDIT_DEFAULT_PAGE_SIZE);
  const fromRaw = parseDateBoundary(query.from ?? query.startDate, "start");
  const toRaw = parseDateBoundary(query.to ?? query.endDate, "end");

  if (page === null) errors.page = ["Page must be a positive integer."];
  if (pageSizeRaw === null) errors.pageSize = ["Page size must be a positive integer."];
  if (fromRaw === null) errors.from = ["From date must be a valid date."];
  if (toRaw === null) errors.to = ["To date must be a valid date."];

  const entityId = parseOptionalString(query.entityId, 64);
  if (entityId && !isUuid(entityId)) {
    errors.entityId = ["Entity ID must be a valid UUID."];
  }

  if (Object.keys(errors).length > 0) {
    return { success: false, errors };
  }

  const to = toRaw ?? now;
  const from = fromRaw ?? new Date(to.getTime() - AUDIT_DEFAULT_LOOKBACK_DAYS * DAY_MS);
  if (from.getTime() > to.getTime()) {
    return { success: false, errors: { dateRange: ["From date must be before to date."] } };
  }
  if (to.getTime() - from.getTime() > AUDIT_MAX_RANGE_DAYS * DAY_MS) {
    return {
      success: false,
      errors: { dateRange: [`Date range cannot exceed ${AUDIT_MAX_RANGE_DAYS} days.`] },
    };
  }

  const pageSize = Math.min(pageSizeRaw ?? AUDIT_DEFAULT_PAGE_SIZE, AUDIT_MAX_PAGE_SIZE);
  return {
    success: true,
    data: {
      page: page ?? 1,
      pageSize,
      offset: ((page ?? 1) - 1) * pageSize,
      entityType: parseOptionalString(query.entityType, 80),
      entityId,
      action: parseOptionalString(query.action, 120),
      search: parseOptionalString(query.search ?? query.q, 120),
      from,
      to,
    },
  };
}

export function isPrivilegedAuditRole(role: UserRole) {
  return role === "super_admin" || role === "hr_qa_approver";
}

export function buildAuditVisibilityCondition(params: {
  userId: string;
  role: UserRole;
  scopeUnitIds: string[];
}) {
  if (isPrivilegedAuditRole(params.role)) return undefined;

  const conditions: SQL[] = [eq(auditLogs.actorUserId, params.userId)];
  if (params.scopeUnitIds.length > 0) {
    conditions.push(
      and(
        eq(auditLogs.entityType, "training_event"),
        sql`exists (
          select 1
          from ${trainingEvents}
          where ${trainingEvents.id} = ${auditLogs.entityId}
            and ${trainingEvents.deletedAt} is null
            and ${inArray(trainingEvents.ownerUnitId, params.scopeUnitIds)}
        )`,
      )!,
      and(
        eq(auditLogs.entityType, "employee"),
        sql`exists (
          select 1
          from ${employees}
          where ${employees.id} = ${auditLogs.entityId}
            and ${employees.deletedAt} is null
            and ${inArray(employees.unitId, params.scopeUnitIds)}
        )`,
      )!,
      and(
        eq(auditLogs.entityType, "attendance_record"),
        sql`exists (
          select 1
          from ${attendanceRecords}
          inner join ${employees}
            on ${employees.id} = ${attendanceRecords.employeeId}
          where ${attendanceRecords.id} = ${auditLogs.entityId}
            and ${attendanceRecords.deletedAt} is null
            and ${employees.deletedAt} is null
            and ${inArray(employees.unitId, params.scopeUnitIds)}
        )`,
      )!,
    );
  }

  return or(...conditions);
}

export function buildAuditWhereConditions(params: {
  query: AuditQueryOptions;
  userId: string;
  role: UserRole;
  scopeUnitIds: string[];
}) {
  const filters: SQL[] = [
    gte(auditLogs.createdAt, params.query.from),
    lte(auditLogs.createdAt, params.query.to),
  ];

  if (params.query.entityType) {
    const matchingEntityTypes = getMatchingAuditEntityTypes(params.query.entityType);
    const pattern = `%${params.query.entityType}%`;
    filters.push(
      or(
        eq(auditLogs.entityType, params.query.entityType),
        ilike(auditLogs.entityType, pattern),
        sql`replace(${auditLogs.entityType}, '_', ' ') ilike ${pattern}`,
        ...(matchingEntityTypes.length > 0
          ? [inArray(auditLogs.entityType, matchingEntityTypes)]
          : []),
      )!,
    );
  }
  if (params.query.entityId) {
    filters.push(eq(auditLogs.entityId, params.query.entityId));
  }
  if (params.query.action) {
    filters.push(eq(auditLogs.action, params.query.action));
  }
  if (params.query.search) {
    const pattern = `%${params.query.search}%`;
    const matchingActions = getMatchingAuditActions(params.query.search);
    const matchingEntityTypes = getMatchingAuditEntityTypes(params.query.search);
    filters.push(
      or(
        ilike(auditLogs.action, pattern),
        ilike(auditLogs.entityType, pattern),
        sql`replace(${auditLogs.action}, '.', ' ') ilike ${pattern}`,
        sql`replace(${auditLogs.entityType}, '_', ' ') ilike ${pattern}`,
        ilike(auditLogs.ip, pattern),
        sql`${auditLogs.entityId}::text ilike ${pattern}`,
        sql`${auditLogs.actorUserId}::text ilike ${pattern}`,
        ...(matchingActions.length > 0 ? [inArray(auditLogs.action, matchingActions)] : []),
        ...(matchingEntityTypes.length > 0
          ? [inArray(auditLogs.entityType, matchingEntityTypes)]
          : []),
      )!,
    );
  }

  const visibility = buildAuditVisibilityCondition({
    userId: params.userId,
    role: params.role,
    scopeUnitIds: params.scopeUnitIds,
  });
  if (visibility) filters.push(visibility);

  return filters;
}
