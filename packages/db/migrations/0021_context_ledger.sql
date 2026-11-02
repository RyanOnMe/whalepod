-- ADR-0025（PC-03a）：项目事实账本（内部事件先行）。
-- Observation/Decision/Correction 与业务引用；SourceRevision、Thread/WorkLink 与
-- 外部来源正文由后续切片增加。所有读面按 status='active' AND corrected_at IS NULL
-- 过滤；Decision 的当前有效行另有部分唯一索引。
create type context_entry_kind as enum ('observation', 'inference', 'decision', 'correction');
create type context_entry_status as enum ('active', 'superseded', 'conflict', 'retracted');
create type context_actor_kind as enum ('member', 'system', 'coordinator');
create type context_citation_kind as enum ('source', 'business');

create table context_entry (
  id uuid primary key,
  project_id uuid not null references project (id),
  kind context_entry_kind not null,
  status context_entry_status not null default 'active',
  corrected_at timestamptz,
  title varchar(200) not null,
  body text not null default '',
  payload jsonb not null default '{}'::jsonb,
  source_id uuid,
  revision_id uuid,
  thread_id uuid,
  business_ref varchar(300),
  business_version varchar(200),
  target_entry_id uuid references context_entry (id),
  evaluation_id uuid,
  input_digest char(64),
  created_by uuid references user_account (id),
  actor_kind context_actor_kind not null,
  processor_version varchar(100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint context_entry_title_length check (length(btrim(title)) between 1 and 200),
  constraint context_entry_body_size check (octet_length(body) <= 65536),
  constraint context_entry_payload_object check (jsonb_typeof(payload) = 'object'),
  constraint context_entry_payload_size check (octet_length(payload::text) <= 16384),
  constraint context_entry_decision_fields check (
    kind <> 'decision'
    or (
      actor_kind = 'member'
      and created_by is not null
      and business_ref is not null
      and business_version is not null
      and target_entry_id is null
      and evaluation_id is null
    )
  ),
  constraint context_entry_observation_fields check (
    kind <> 'observation'
    or (
      actor_kind = 'system'
      and (business_ref is not null or source_id is not null)
      and target_entry_id is null
      and evaluation_id is null
    )
  ),
  constraint context_entry_inference_fields check (
    kind <> 'inference'
    or (
      actor_kind = 'coordinator'
      and evaluation_id is not null
      and input_digest is not null
      and target_entry_id is null
    )
  ),
  constraint context_entry_correction_fields check (
    kind <> 'correction'
    or (
      actor_kind = 'member'
      and created_by is not null
      and target_entry_id is not null
      and business_ref is null
      and business_version is null
      and evaluation_id is null
      and corrected_at is null
    )
  ),
  constraint context_entry_business_pair check (
    (business_ref is null) = (business_version is null)
  ),
  constraint context_entry_corrected_at_kind check (corrected_at is null or kind <> 'correction')
);

-- 同一业务版本的 Decision 投影幂等；当前有效 Decision 每个 business_ref 至多一条。
create unique index context_entry_decision_version_unique
  on context_entry (business_ref, business_version)
  where kind = 'decision';
create unique index context_entry_decision_active_unique
  on context_entry (business_ref)
  where kind = 'decision' and status = 'active' and corrected_at is null;
-- Observation 的确定性投影按 businessRef+version 幂等（Run 终态等）。
create unique index context_entry_observation_version_unique
  on context_entry (business_ref, business_version)
  where kind = 'observation';
-- 同一目标只允许一条纠正；重复纠正返回既有行。
create unique index context_entry_correction_target_unique
  on context_entry (target_entry_id)
  where kind = 'correction';
create index context_entry_project_created_idx on context_entry (project_id, created_at desc, id);
create index context_entry_business_ref_idx on context_entry (business_ref) where business_ref is not null;

create table context_citation (
  id bigserial primary key,
  entry_id uuid not null references context_entry (id) on delete cascade,
  kind context_citation_kind not null,
  source_id uuid,
  revision_id uuid,
  resource_key text,
  thread_key varchar(300),
  locator text,
  authorization_generation integer,
  observed_at timestamptz,
  digest char(64),
  business_ref varchar(300),
  business_version varchar(200),
  occurred_at timestamptz,
  constraint context_citation_source_fields check (
    kind <> 'source'
    or (
      source_id is not null
      and revision_id is not null
      and resource_key is not null
      and locator is not null
      and authorization_generation is not null
      and observed_at is not null
      and digest is not null
      and business_ref is null
      and business_version is null
      and occurred_at is null
    )
  ),
  constraint context_citation_business_fields check (
    kind <> 'business'
    or (
      business_ref is not null
      and business_version is not null
      and occurred_at is not null
      and source_id is null
      and revision_id is null
      and resource_key is null
      and locator is null
      and authorization_generation is null
      and observed_at is null
      and digest is null
    )
  )
);
create index context_citation_entry_idx on context_citation (entry_id, id);
