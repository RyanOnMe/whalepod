-- ADR-0030: stable discovery executor limits and one-use per-call accounting.
create table discovery_executor_parent_budget (
  slot_id uuid primary key references discovery_slot(id),
  project_id uuid not null references project(id),
  dispatches bigint not null default 0,
  calls bigint not null default 0,
  reserved_tokens bigint not null default 0,
  reserved_cost_micros bigint not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_micros bigint not null default 0,
  egress_blocked_at timestamptz,
  constraint discovery_executor_parent_nonnegative check (
    dispatches >= 0 and calls >= 0 and reserved_tokens >= 0
    and reserved_cost_micros >= 0 and input_tokens >= 0 and output_tokens >= 0 and cost_micros >= 0
  )
);

create table discovery_executor_dispatch (
  run_id uuid primary key references run(id),
  execution_id uuid not null unique references discovery_execution(id),
  slot_id uuid not null references discovery_slot(id),
  permit_id uuid not null references discovery_permit(id),
  permit_version integer not null,
  project_id uuid not null references project(id),
  team_id uuid not null references team(id),
  work_id uuid not null references work(id),
  work_key uuid not null,
  source_grants_digest char(64) not null,
  route_digest char(64) not null,
  policy_generation integer not null,
  policy jsonb not null,
  created_at timestamptz not null,
  constraint discovery_executor_dispatch_versions check (permit_version > 0 and policy_generation > 0),
  constraint discovery_executor_dispatch_binding check (
    route_digest ~ '^[0-9a-f]{64}$' and source_grants_digest ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(policy) = 'object'
  )
);

create table discovery_executor_attempt (
  run_id uuid not null references discovery_executor_dispatch(run_id),
  attempt_id uuid not null,
  request_digest char(64) not null,
  request_bytes integer not null,
  utc_date varchar(10) not null,
  max_input_tokens bigint not null,
  max_output_tokens bigint not null,
  reserved_cost_micros bigint not null,
  state varchar(16) not null,
  input_tokens bigint,
  output_tokens bigint,
  cost_micros bigint,
  response_id_digest char(64),
  overage boolean not null default false,
  created_at timestamptz not null,
  settled_at timestamptz,
  primary key (run_id, attempt_id),
  constraint discovery_executor_attempt_reservation check (
    request_digest ~ '^[0-9a-f]{64}$' and request_bytes > 0
    and utc_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    and max_input_tokens > 0 and max_output_tokens > 0 and reserved_cost_micros >= 0
  ),
  constraint discovery_executor_attempt_settlement check (
    (state in ('held','unknown') and settled_at is null and input_tokens is null and output_tokens is null
      and cost_micros is null and response_id_digest is null and not overage)
    or (state in ('actual','estimated','unsent') and settled_at is not null
      and input_tokens is not null and input_tokens >= 0 and output_tokens is not null and output_tokens >= 0
      and cost_micros is not null and cost_micros >= 0
      and (response_id_digest is null or (state = 'actual' and response_id_digest ~ '^[0-9a-f]{64}$'))
      and (not overage or state = 'actual'))
  )
);

create unique index discovery_executor_attempt_one_open
  on discovery_executor_attempt (run_id) where state in ('held', 'unknown');
create unique index discovery_executor_attempt_request_identity
  on discovery_executor_attempt (run_id, request_digest);
