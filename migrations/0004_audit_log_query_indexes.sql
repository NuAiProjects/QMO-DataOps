create index if not exists audit_logs_created_at_idx
  on audit_logs (created_at desc);

create index if not exists audit_logs_entity_type_created_at_idx
  on audit_logs (entity_type, created_at desc);

create index if not exists audit_logs_entity_id_idx
  on audit_logs (entity_id)
  where entity_id is not null;

create index if not exists audit_logs_actor_user_created_at_idx
  on audit_logs (actor_user_id, created_at desc)
  where actor_user_id is not null;

create index if not exists audit_logs_action_created_at_idx
  on audit_logs (action, created_at desc);

create index if not exists training_events_owner_unit_id_idx
  on training_events (owner_unit_id)
  where deleted_at is null;

create index if not exists employees_unit_id_idx
  on employees (unit_id)
  where deleted_at is null;

create index if not exists attendance_records_employee_id_idx
  on attendance_records (employee_id)
  where deleted_at is null;
