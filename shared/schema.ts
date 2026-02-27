import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const userRoleEnum = pgEnum("user_role", [
  "super_admin",
  "hr_qa_approver",
  "unit_head",
  "encoder",
  "viewer_auditor",
]);

export const authProviderEnum = pgEnum("auth_provider", ["google", "microsoft"]);

export const employmentStatusEnum = pgEnum("employment_status", [
  "active",
  "inactive",
]);

export const deliveryModeEnum = pgEnum("delivery_mode", [
  "in_person",
  "virtual",
  "hybrid",
  "self_paced",
]);

export const visibilityScopeEnum = pgEnum("visibility_scope", [
  "unit",
  "department",
  "org",
]);

export const workflowStatusEnum = pgEnum("workflow_status", [
  "draft",
  "submitted",
  "returned",
  "approved",
  "locked",
]);

export const attendanceStatusEnum = pgEnum("attendance_status", [
  "present",
  "absent",
  "partial",
]);

export const importBatchStatusEnum = pgEnum("import_batch_status", [
  "parsed",
  "needs_review",
  "committed",
]);

export const importMatchStatusEnum = pgEnum("import_match_status", [
  "matched",
  "unmatched",
  "invalid",
]);

export const attachmentEntityTypeEnum = pgEnum("attachment_entity_type", [
  "attendance_record",
  "training_event",
  "employee",
]);

export const workflowEntityTypeEnum = pgEnum("workflow_entity_type", [
  "training_event",
  "attendance_record",
  "attendance_import_batch",
]);

export const workflowActionEnum = pgEnum("workflow_action", [
  "submit",
  "return",
  "approve",
  "lock",
  "reopen",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: varchar("email", { length: 255 }).notNull().unique(),
  fullName: text("full_name").notNull(),
  role: userRoleEnum("role").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: authProviderEnum("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    providerSubjectUnique: uniqueIndex("auth_identities_provider_subject_uq").on(
      t.provider,
      t.providerSubject,
    ),
  }),
);

export const units = pgTable("units", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  code: varchar("code", { length: 50 }),
  parentUnitId: uuid("parent_unit_id").references((): AnyPgColumn => units.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userUnits = pgTable(
  "user_units",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.unitId] }),
  }),
);

export const employees = pgTable("employees", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  employeeNo: varchar("employee_no", { length: 50 }).notNull().unique(),
  fullName: text("full_name").notNull(),
  email: varchar("email", { length: 255 }),
  unitId: uuid("unit_id")
    .notNull()
    .references(() => units.id, { onDelete: "restrict" }),
  position: text("position"),
  employmentStatus: employmentStatusEnum("employment_status")
    .notNull()
    .default("active"),
  hireDate: date("hire_date"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const trainingEvents = pgTable("training_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description"),
  category: text("category"),
  deliveryMode: deliveryModeEnum("delivery_mode").notNull(),
  provider: text("provider"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  hours: numeric("hours", { precision: 6, scale: 2 }).notNull(),
  ownerUnitId: uuid("owner_unit_id")
    .notNull()
    .references(() => units.id, { onDelete: "restrict" }),
  visibilityScope: visibilityScopeEnum("visibility_scope")
    .notNull()
    .default("unit"),
  isMandatory: boolean("is_mandatory").notNull().default(false),
  workflowStatus: workflowStatusEnum("workflow_status")
    .notNull()
    .default("draft"),
  returnNotes: text("return_notes"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  updatedBy: uuid("updated_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  entityType: attachmentEntityTypeEnum("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storagePath: text("storage_path").notNull(),
  uploadedBy: uuid("uploaded_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const attendanceRecords = pgTable(
  "attendance_records",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    trainingEventId: uuid("training_event_id")
      .notNull()
      .references(() => trainingEvents.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    attendanceDate: date("attendance_date").notNull(),
    hoursCredited: numeric("hours_credited", { precision: 6, scale: 2 })
      .notNull()
      .default("0"),
    attendanceStatus: attendanceStatusEnum("attendance_status")
      .notNull()
      .default("present"),
    workflowStatus: workflowStatusEnum("workflow_status")
      .notNull()
      .default("draft"),
    returnNotes: text("return_notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniqueAttendance: uniqueIndex("attendance_unique")
      .on(t.trainingEventId, t.employeeId, t.attendanceDate),
  }),
);

export const attendanceImportBatches = pgTable("attendance_import_batches", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  trainingEventId: uuid("training_event_id")
    .notNull()
    .references(() => trainingEvents.id, { onDelete: "cascade" }),
  uploadedBy: uuid("uploaded_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  fileName: text("file_name").notNull(),
  status: importBatchStatusEnum("status").notNull().default("parsed"),
  summaryJson: jsonb("summary_json").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const attendanceImportRows = pgTable("attendance_import_rows", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => attendanceImportBatches.id, { onDelete: "cascade" }),
  rawRowJson: jsonb("raw_row_json").notNull(),
  employeeNo: varchar("employee_no", { length: 50 }).notNull(),
  resolvedEmployeeId: uuid("resolved_employee_id").references(() => employees.id, {
    onDelete: "set null",
  }),
  matchStatus: importMatchStatusEnum("match_status")
    .notNull()
    .default("unmatched"),
  errorMessage: text("error_message"),
});

export const workflowActions = pgTable("workflow_actions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  entityType: workflowEntityTypeEnum("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  action: workflowActionEnum("action").notNull(),
  actorUserId: uuid("actor_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  actorUserId: uuid("actor_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id"),
  beforeJson: jsonb("before_json"),
  afterJson: jsonb("after_json"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  ip: text("ip"),
});

export const insertUserSchema = createInsertSchema(users);
export const insertUnitSchema = createInsertSchema(units);
export const insertEmployeeSchema = createInsertSchema(employees);
export const insertTrainingEventSchema = createInsertSchema(trainingEvents);
export const insertAttendanceSchema = createInsertSchema(attendanceRecords);

export type UserRole = (typeof userRoleEnum.enumValues)[number];
export type AuthProvider = (typeof authProviderEnum.enumValues)[number];
export type EmploymentStatus = (typeof employmentStatusEnum.enumValues)[number];
export type DeliveryMode = (typeof deliveryModeEnum.enumValues)[number];
export type VisibilityScope = (typeof visibilityScopeEnum.enumValues)[number];
export type WorkflowStatus = (typeof workflowStatusEnum.enumValues)[number];
export type AttendanceStatus = (typeof attendanceStatusEnum.enumValues)[number];
export type ImportBatchStatus = (typeof importBatchStatusEnum.enumValues)[number];
export type ImportMatchStatus = (typeof importMatchStatusEnum.enumValues)[number];
export type AttachmentEntityType = (typeof attachmentEntityTypeEnum.enumValues)[number];
export type WorkflowEntityType = (typeof workflowEntityTypeEnum.enumValues)[number];
export type WorkflowAction = (typeof workflowActionEnum.enumValues)[number];

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type NewUser = z.infer<typeof insertUserSchema>;
export type Unit = typeof units.$inferSelect;
export type Employee = typeof employees.$inferSelect;
export type TrainingEvent = typeof trainingEvents.$inferSelect;
export type AttendanceRecord = typeof attendanceRecords.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
