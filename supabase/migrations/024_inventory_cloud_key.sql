-- FortiGate (and similar) cloud registration keys, captured on outbound movement only.
alter table public.inventory_items
  add column if not exists cloud_key text;

comment on column public.inventory_items.cloud_key is 'Vendor cloud / registration key; set when scanning FortiGate units out, not required on inbound.';
