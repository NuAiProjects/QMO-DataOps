export interface Employee {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  department: string;
  position: string;
  status: 'Active' | 'Inactive';
  dateHired: string;
}

export interface TrainingEvent {
  id: string;
  title: string;
  date: string;
  organizer: string;
  type: 'Webinar' | 'Workshop' | 'Seminar' | 'Conference';
  hours: number;
  status: 'Upcoming' | 'Completed' | 'Draft' | 'Pending Approval';
  attendees: number;
}

export interface AttendanceRecord {
  id: string;
  employeeId: string;
  eventId: string;
  status: 'Present' | 'Absent' | 'Pending';
  proofUrl?: string;
}

export const mockEmployees: Employee[] = [
  { id: '1', employeeId: 'NU-2023-001', firstName: 'Juan', lastName: 'Dela Cruz', email: 'jdelacruz@national-u.edu.ph', department: 'College of Computing', position: 'Dean', status: 'Active', dateHired: '2020-01-15' },
  { id: '2', employeeId: 'NU-2023-002', firstName: 'Maria', lastName: 'Santos', email: 'msantos@national-u.edu.ph', department: 'HR Department', position: 'HR Manager', status: 'Active', dateHired: '2019-05-20' },
  { id: '3', employeeId: 'NU-2023-003', firstName: 'Pedro', lastName: 'Penduko', email: 'ppenduko@national-u.edu.ph', department: 'College of Computing', position: 'Instructor I', status: 'Active', dateHired: '2021-08-01' },
  { id: '4', employeeId: 'NU-2023-004', firstName: 'Jose', lastName: 'Rizal', email: 'jrizal@national-u.edu.ph', department: 'College of Arts', position: 'Professor', status: 'Active', dateHired: '2018-06-12' },
  { id: '5', employeeId: 'NU-2023-005', firstName: 'Andres', lastName: 'Bonifacio', email: 'abonifacio@national-u.edu.ph', department: 'College of Engineering', position: 'Lab Technician', status: 'Inactive', dateHired: '2022-01-10' },
];

export const mockTrainings: TrainingEvent[] = [
  { id: '1', title: 'Annual Quality Assurance Summit 2025', date: '2025-03-15', organizer: 'QMO Manila', type: 'Conference', hours: 8, status: 'Upcoming', attendees: 0 },
  { id: '2', title: 'Advanced Pedagogical Strategies', date: '2025-02-20', organizer: 'HR Department', type: 'Workshop', hours: 4, status: 'Completed', attendees: 45 },
  { id: '3', title: 'Data Privacy Act Compliance', date: '2025-01-10', organizer: 'IT Department', type: 'Webinar', hours: 2, status: 'Completed', attendees: 120 },
  { id: '4', title: 'Research Methodology Workshop', date: '2025-04-05', organizer: 'Research Office', type: 'Workshop', hours: 6, status: 'Draft', attendees: 0 },
  { id: '5', title: 'Mental Health Awareness for Educators', date: '2025-02-28', organizer: 'Guidance Office', type: 'Seminar', hours: 3, status: 'Pending Approval', attendees: 0 },
];
