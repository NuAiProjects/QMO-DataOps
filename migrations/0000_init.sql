CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "user_role" AS ENUM (
  'super_admin',
  'hr_qa_approver',
  'unit_head',
  'encoder',
  'viewer_auditor'
);

CREATE TYPE "auth_provider" AS ENUM ('google', 'microsoft');

CREATE TYPE "employment_status" AS ENUM ('active', 'inactive');

CREATE TYPE "delivery_mode" AS ENUM ('in_person', 'virtual', 'hybrid', 'self_paced');

CREATE TYPE "visibility_scope" AS ENUM ('unit', 'department', 'org');

CREATE TYPE "workflow_status" AS ENUM ('draft', 'submitted', 'returned', 'approved', 'locked');

CREATE TYPE "attendance_status" AS ENUM ('present', 'absent', 'partial');

CREATE TYPE "import_batch_status" AS ENUM ('parsed', 'needs_review', 'committed');

CREATE TYPE "import_match_status" AS ENUM ('matched', 'unmatched', 'invalid');

CREATE TYPE "attachment_entity_type" AS ENUM (
  'attendance_record',
  'training_event',
  'employee'
);

CREATE TYPE "workflow_entity_type" AS ENUM (
  'training_event',
  'attendance_record',
  'attendance_import_batch'
);

CREATE TYPE "workflow_action" AS ENUM (
  'submit',
  'return',
  'approve',
  'lock',
  'reopen'
);

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" varchar(255) NOT NULL UNIQUE,
  "full_name" text NOT NULL,
  "role" "user_role" NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "auth_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" "auth_provider" NOT NULL,
  "provider_subject" text NOT NULL,
  "email" varchar(255) NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "auth_identities_provider_subject_uq"
  ON "auth_identities" ("provider", "provider_subject");

CREATE TABLE "units" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "code" varchar(50),
  "parent_unit_id" uuid REFERENCES "units"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "user_units" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "unit_id" uuid NOT NULL REFERENCES "units"("id") ON DELETE CASCADE,
  PRIMARY KEY ("user_id", "unit_id")
);

CREATE TABLE "employees" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "employee_no" varchar(50) NOT NULL UNIQUE,
  "full_name" text NOT NULL,
  "email" varchar(255),
  "unit_id" uuid NOT NULL REFERENCES "units"("id") ON DELETE RESTRICT,
  "position" text,
  "employment_status" "employment_status" NOT NULL DEFAULT 'active',
  "hire_date" date,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "training_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title" text NOT NULL,
  "description" text,
  "category" text,
  "delivery_mode" "delivery_mode" NOT NULL,
  "provider" text,
  "start_date" date NOT NULL,
  "end_date" date NOT NULL,
  "hours" numeric(6,2) NOT NULL,
  "owner_unit_id" uuid NOT NULL REFERENCES "units"("id") ON DELETE RESTRICT,
  "visibility_scope" "visibility_scope" NOT NULL DEFAULT 'unit',
  "is_mandatory" boolean NOT NULL DEFAULT false,
  "workflow_status" "workflow_status" NOT NULL DEFAULT 'draft',
  "return_notes" text,
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "updated_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_type" "attachment_entity_type" NOT NULL,
  "entity_id" uuid NOT NULL,
  "file_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "storage_path" text NOT NULL,
  "uploaded_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "uploaded_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "attendance_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "training_event_id" uuid NOT NULL REFERENCES "training_events"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "attendance_date" date NOT NULL,
  "hours_credited" numeric(6,2) NOT NULL DEFAULT 0,
  "attendance_status" "attendance_status" NOT NULL DEFAULT 'present',
  "workflow_status" "workflow_status" NOT NULL DEFAULT 'draft',
  "return_notes" text,
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "updated_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "attendance_unique"
  ON "attendance_records" ("training_event_id", "employee_id", "attendance_date");

CREATE TABLE "attendance_import_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "training_event_id" uuid NOT NULL REFERENCES "training_events"("id") ON DELETE CASCADE,
  "uploaded_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "file_name" text NOT NULL,
  "status" "import_batch_status" NOT NULL DEFAULT 'parsed',
  "summary_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "attendance_import_rows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "batch_id" uuid NOT NULL REFERENCES "attendance_import_batches"("id") ON DELETE CASCADE,
  "raw_row_json" jsonb NOT NULL,
  "employee_no" varchar(50) NOT NULL,
  "resolved_employee_id" uuid REFERENCES "employees"("id") ON DELETE SET NULL,
  "match_status" "import_match_status" NOT NULL DEFAULT 'unmatched',
  "error_message" text
);

CREATE TABLE "workflow_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "entity_type" "workflow_entity_type" NOT NULL,
  "entity_id" uuid NOT NULL,
  "action" "workflow_action" NOT NULL,
  "actor_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid,
  "before_json" jsonb,
  "after_json" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ip" text
);
