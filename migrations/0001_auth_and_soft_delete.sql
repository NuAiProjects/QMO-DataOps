create table if not exists user_password_credentials (
  user_id uuid primary key references users(id) on delete cascade,
  password_hash text not null,
  password_algo text not null default 'scrypt_v1',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);

alter table employees
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references users(id) on delete set null,
  add column if not exists delete_reason text;

alter table training_events
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references users(id) on delete set null,
  add column if not exists delete_reason text;

alter table attendance_records
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references users(id) on delete set null,
  add column if not exists delete_reason text;
