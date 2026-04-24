update training_events as te
set owner_unit_id = u.id
from units as u
where te.deleted_at is null
  and lower(regexp_replace(coalesce(te.provider, ''), '\s+', ' ', 'g')) =
    lower(regexp_replace(u.name, '\s+', ' ', 'g'))
  and te.owner_unit_id <> u.id;
