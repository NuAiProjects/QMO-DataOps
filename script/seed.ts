import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { randomBytes, scryptSync } from "crypto";
import {
  attachments,
  attendanceRecords,
  attendanceImportBatches,
  attendanceImportRows,
  auditLogs,
  employees,
  authIdentities,
  trainingEvents,
  units,
  userUnits,
  workflowActions,
  users,
  userPasswordCredentials,
} from "../shared/schema";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt_v1$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function seed() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed the database.");
  }

  const shouldDisableTlsVerification = process.env.PGSSL_NO_VERIFY === "true";
  const connectionString = shouldDisableTlsVerification
    ? (() => {
        const url = new URL(databaseUrl);
        url.searchParams.set("sslmode", "no-verify");
        return url.toString();
      })()
    : databaseUrl;

  const pool = new Pool({
    connectionString,
    ssl: shouldDisableTlsVerification ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool);

  await db.delete(attendanceImportRows);
  await db.delete(attendanceImportBatches);
  await db.delete(workflowActions);
  await db.delete(auditLogs);
  await db.delete(userUnits);
  await db.delete(userPasswordCredentials);
  await db.delete(attachments);
  await db.delete(attendanceRecords);
  await db.delete(trainingEvents);
  await db.delete(employees);
  await db.delete(authIdentities);
  await db.delete(units);
  await db.delete(users);

  const [qmoDept, acadDept] = await db
    .insert(units)
    .values([
      { name: "Quality Management Office", code: "QMO" },
      { name: "Academic Affairs", code: "ACAD" },
    ])
    .returning();

  const [qaTeam, trainingTeam, compTeam, engTeam] = await db
    .insert(units)
    .values([
      { name: "Quality Assurance Team", code: "QMO-QA", parentUnitId: qmoDept.id },
      {
        name: "Training Operations Team",
        code: "QMO-TRN",
        parentUnitId: qmoDept.id,
      },
      { name: "College of Computing", code: "ACAD-COMP", parentUnitId: acadDept.id },
      {
        name: "College of Engineering",
        code: "ACAD-ENG",
        parentUnitId: acadDept.id,
      },
    ])
    .returning();

  const [superAdmin, hrqa, unitHead, encoder, viewer] = await db
    .insert(users)
    .values([
      {
        email: "admin@qmo.local",
        fullName: "Super Admin",
        role: "super_admin",
        isActive: true,
      },
      {
        email: "qa.approver@qmo.local",
        fullName: "HR/QA Approver",
        role: "hr_qa_approver",
        isActive: true,
      },
      {
        email: "unit.head@qmo.local",
        fullName: "Unit Head",
        role: "unit_head",
        isActive: true,
      },
      {
        email: "encoder@qmo.local",
        fullName: "Encoder",
        role: "encoder",
        isActive: true,
      },
      {
        email: "auditor@qmo.local",
        fullName: "Viewer Auditor",
        role: "viewer_auditor",
        isActive: true,
      },
    ])
    .returning();

  await db.insert(userUnits).values([
    { userId: superAdmin.id, unitId: qmoDept.id },
    { userId: superAdmin.id, unitId: acadDept.id },
    { userId: hrqa.id, unitId: qmoDept.id },
    { userId: unitHead.id, unitId: compTeam.id },
    { userId: encoder.id, unitId: compTeam.id },
    { userId: viewer.id, unitId: acadDept.id },
  ]);

  await db.insert(userPasswordCredentials).values([
    {
      userId: superAdmin.id,
      passwordHash: hashPassword("Admin@12345"),
      passwordAlgo: "scrypt_v1",
      updatedBy: superAdmin.id,
    },
    {
      userId: hrqa.id,
      passwordHash: hashPassword("User@12345"),
      passwordAlgo: "scrypt_v1",
      updatedBy: superAdmin.id,
    },
    {
      userId: unitHead.id,
      passwordHash: hashPassword("User@12345"),
      passwordAlgo: "scrypt_v1",
      updatedBy: superAdmin.id,
    },
    {
      userId: encoder.id,
      passwordHash: hashPassword("User@12345"),
      passwordAlgo: "scrypt_v1",
      updatedBy: superAdmin.id,
    },
    {
      userId: viewer.id,
      passwordHash: hashPassword("User@12345"),
      passwordAlgo: "scrypt_v1",
      updatedBy: superAdmin.id,
    },
  ]);

  const employeeValues = Array.from({ length: 20 }).map((_, index) => {
    const employeeNo = `EMP-${1001 + index}`;
    const fullName = `Employee ${index + 1}`;
    const unitId =
      index < 5
        ? qaTeam.id
        : index < 10
          ? trainingTeam.id
          : index < 15
            ? compTeam.id
            : engTeam.id;
    return {
      employeeNo,
      fullName,
      email: `employee${index + 1}@qmo.local`,
      unitId,
      position: index % 2 === 0 ? "Staff" : "Supervisor",
      employmentStatus: (index % 7 === 0 ? "inactive" : "active") as "active" | "inactive",
      hireDate: "2021-01-15",
    };
  });

  const seededEmployees = await db
    .insert(employees)
    .values(employeeValues)
    .returning();

  const [eventA, eventB, eventC, eventD, eventE] = await db
    .insert(trainingEvents)
    .values([
      {
        title: "QMS Orientation",
        description: "Quality Management System orientation session",
        category: "Compliance",
        deliveryMode: "in_person",
        provider: "QMO",
        startDate: "2025-01-10",
        endDate: "2025-01-10",
        hours: "4",
        ownerUnitId: qmoDept.id,
        visibilityScope: "department",
        isMandatory: true,
        workflowStatus: "approved",
        createdBy: superAdmin.id,
        updatedBy: superAdmin.id,
      },
      {
        title: "Data Privacy Essentials",
        description: "Mandatory data privacy training",
        category: "Compliance",
        deliveryMode: "virtual",
        provider: "IT Office",
        startDate: "2025-02-05",
        endDate: "2025-02-05",
        hours: "2",
        ownerUnitId: acadDept.id,
        visibilityScope: "org",
        isMandatory: true,
        workflowStatus: "submitted",
        createdBy: superAdmin.id,
        updatedBy: superAdmin.id,
      },
      {
        title: "Teaching Excellence Workshop",
        description: "Faculty development workshop",
        category: "Faculty Development",
        deliveryMode: "hybrid",
        provider: "Academic Affairs",
        startDate: "2025-03-12",
        endDate: "2025-03-12",
        hours: "6",
        ownerUnitId: compTeam.id,
        visibilityScope: "department",
        isMandatory: false,
        workflowStatus: "draft",
        createdBy: unitHead.id,
        updatedBy: unitHead.id,
      },
      {
        title: "Safety Training",
        description: "Laboratory safety certification",
        category: "Safety",
        deliveryMode: "in_person",
        provider: "Safety Office",
        startDate: "2025-04-20",
        endDate: "2025-04-20",
        hours: "3",
        ownerUnitId: engTeam.id,
        visibilityScope: "unit",
        isMandatory: false,
        workflowStatus: "approved",
        createdBy: superAdmin.id,
        updatedBy: superAdmin.id,
      },
      {
        title: "Leadership Essentials",
        description: "Leadership development series",
        category: "Leadership",
        deliveryMode: "virtual",
        provider: "External",
        startDate: "2025-05-02",
        endDate: "2025-05-02",
        hours: "5",
        ownerUnitId: qmoDept.id,
        visibilityScope: "org",
        isMandatory: false,
        workflowStatus: "approved",
        createdBy: superAdmin.id,
        updatedBy: superAdmin.id,
      },
    ])
    .returning();

  const attendanceSeed = await db
    .insert(attendanceRecords)
    .values([
      {
        trainingEventId: eventA.id,
        employeeId: seededEmployees[0].id,
        attendanceDate: "2025-01-10",
        hoursCredited: "4",
        attendanceStatus: "present",
        workflowStatus: "approved",
        createdBy: superAdmin.id,
        updatedBy: superAdmin.id,
      },
      {
        trainingEventId: eventA.id,
        employeeId: seededEmployees[1].id,
        attendanceDate: "2025-01-10",
        hoursCredited: "4",
        attendanceStatus: "present",
        workflowStatus: "approved",
        createdBy: superAdmin.id,
        updatedBy: superAdmin.id,
      },
      {
        trainingEventId: eventD.id,
        employeeId: seededEmployees[15].id,
        attendanceDate: "2025-04-20",
        hoursCredited: "3",
        attendanceStatus: "present",
        workflowStatus: "approved",
        createdBy: superAdmin.id,
        updatedBy: superAdmin.id,
      },
      {
        trainingEventId: eventE.id,
        employeeId: seededEmployees[12].id,
        attendanceDate: "2025-05-02",
        hoursCredited: "5",
        attendanceStatus: "present",
        workflowStatus: "submitted",
        createdBy: superAdmin.id,
        updatedBy: superAdmin.id,
      },
    ])
    .returning();

  const [certOne, certTwo] = await db
    .insert(attachments)
    .values([
      {
        entityType: "attendance_record",
        entityId: attendanceSeed[0].id,
        fileName: "seed-cert-1.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        storagePath: "uploads/seed-cert-1.pdf",
        uploadedBy: superAdmin.id,
      },
      {
        entityType: "attendance_record",
        entityId: attendanceSeed[2].id,
        fileName: "seed-cert-2.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        storagePath: "uploads/seed-cert-2.pdf",
        uploadedBy: superAdmin.id,
      },
    ])
    .returning();

  await pool.end();
}

seed().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
