-- ADR-0030 RD-04b（Issue #534）：按事实与槽位预授权，把发现候选立为一个已承接任务。
--
-- 边界：
--   * 预授权（discovery_permit）是责任人本人的真实回执快照；Hub 物化只引用它，
--     不伪造 accepted_at/confirmed_by。
--   * 槽位身份与占用由唯一约束兜底，人工创建与自动立项共用同一把 Project 锁。
--   * 来源绑定只由 Hub 写入，供 RD-04c 的专用读取使用；本迁移不产生可执行 Mandate。

-- 派生约定不是正式确认版本：普通 resolver 只读 status='confirmed'。
alter table task_spec_revision
  drop constraint task_spec_revision_confirmed_fields;
alter table task_spec_revision
  add constraint task_spec_revision_confirmed_fields check (
    (status = 'confirmed' and revision_number is not null
      and confirmed_by is not null and confirmed_at is not null)
    or (status = 'draft' and revision_number is null
      and confirmed_by is null and confirmed_at is null)
    or (status = 'derived' and revision_number is null
      and confirmed_by is null and confirmed_at is null
      and origin = 'preauthorized_template')
  );
create unique index task_spec_revision_one_derived
  on task_spec_revision (task_id)
  where status = 'derived';

-- 旧 RD-04a 配置没有立项档字段；补成默认「仅发现」，不能让升级后的读取炸掉。
update discovery_configuration
set settings = settings || jsonb_build_object(
  'tier', 'discover',
  'template', jsonb_build_object(
    'goal', '', 'constraints', '', 'acceptance', '', 'openQuestions', ''
  ),
  'verifierUserIds', '[]'::jsonb,
  'maxCreations', 1
)
where not (settings ? 'tier');

create table discovery_slot (
  id uuid primary key,
  project_id uuid not null references project (id),
  activity varchar(120) not null,
  slot varchar(240) not null,
  generation integer not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint discovery_slot_generation check (generation >= 0),
  constraint discovery_slot_identity unique (project_id, activity, slot)
);

create table discovery_permit (
  id uuid primary key,
  project_id uuid not null references project (id),
  slot_id uuid not null references discovery_slot (id),
  config_version integer not null,
  version integer not null,
  principal_user_id uuid not null references user_account (id),
  entry_task_id uuid not null references task (id),
  tier varchar(16) not null,
  template_version varchar(128) not null,
  template jsonb not null,
  template_digest char(64) not null,
  max_creations integer not null,
  expires_at timestamptz not null,
  verifier_user_ids jsonb not null,
  confirmed_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason varchar(64),
  constraint discovery_permit_tier check (tier in ('discover', 'create', 'execute')),
  constraint discovery_permit_versions check (config_version > 0 and version > 0),
  constraint discovery_permit_template_object check (
    jsonb_typeof(template) = 'object' and octet_length(template::text) <= 65536
  ),
  constraint discovery_permit_template_digest check (template_digest ~ '^[a-f0-9]{64}$'),
  constraint discovery_permit_creations check (max_creations >= 1),
  constraint discovery_permit_expiry check (expires_at > confirmed_at),
  constraint discovery_permit_verifiers check (
    jsonb_typeof(verifier_user_ids) = 'array'
    and jsonb_array_length(case when jsonb_typeof(verifier_user_ids) = 'array'
      then verifier_user_ids else '[]'::jsonb end) between 0 and 16
    and (tier = 'discover' or jsonb_array_length(verifier_user_ids) >= 1)
  ),
  constraint discovery_permit_revocation check (
    (revoked_at is null and revoked_reason is null)
    or (revoked_at is not null and revoked_reason is not null)
  ),
  constraint discovery_permit_principal_version unique (project_id, principal_user_id, version)
);
create index discovery_permit_active
  on discovery_permit (project_id, principal_user_id, config_version)
  where revoked_at is null;

create table discovery_slot_verification (
  id uuid primary key,
  slot_id uuid not null references discovery_slot (id),
  project_id uuid not null references project (id),
  generation integer not null,
  catalog_digest char(64) not null,
  entries jsonb not null,
  verified_by uuid not null references user_account (id),
  permit_id uuid not null references discovery_permit (id),
  permit_version integer not null,
  verified_at timestamptz not null,
  constraint discovery_slot_verification_generation check (generation >= 0),
  constraint discovery_slot_verification_digest check (catalog_digest ~ '^[a-f0-9]{64}$'),
  constraint discovery_slot_verification_entries check (
    jsonb_typeof(entries) = 'array'
    and jsonb_array_length(case when jsonb_typeof(entries) = 'array'
      then entries else '[]'::jsonb end) <= 64
    and octet_length(entries::text) <= 65536
  ),
  constraint discovery_slot_verification_permit_version check (permit_version > 0),
  constraint discovery_slot_verification_generation_unique unique (slot_id, generation)
);

-- 独立核实回执：只记录「该核实人确认的是评论的这一版」，不存正文。
create table discovery_verification (
  id uuid primary key,
  project_id uuid not null references project (id),
  slot_id uuid not null references discovery_slot (id),
  permit_id uuid not null references discovery_permit (id),
  permit_version integer not null,
  source_id uuid not null references task_message (id),
  source_version varchar(64) not null,
  source_digest char(64) not null,
  verifier_user_id uuid not null references user_account (id),
  kind varchar(16) not null,
  created_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason varchar(64),
  constraint discovery_verification_kind check (kind in ('receipt')),
  constraint discovery_verification_digest check (source_digest ~ '^[a-f0-9]{64}$'),
  constraint discovery_verification_permit_version check (permit_version > 0),
  constraint discovery_verification_revocation check (
    (revoked_at is null and revoked_reason is null)
    or (revoked_at is not null and revoked_reason is not null)
  )
);
create unique index discovery_verification_current
  on discovery_verification (source_id, slot_id, permit_id, verifier_user_id)
  where revoked_at is null;

create table discovery_application (
  id uuid primary key,
  candidate_id uuid not null unique references discovery_candidate (id),
  evaluation_id uuid not null unique references coordination_evaluation (id),
  project_id uuid not null references project (id),
  slot_id uuid not null references discovery_slot (id),
  permit_id uuid not null references discovery_permit (id),
  permit_version integer not null,
  source_id uuid not null references task_message (id),
  source_version varchar(64) not null,
  source_digest char(64) not null,
  verification jsonb not null,
  task_id uuid not null unique references task (id),
  work_id uuid not null unique references work (id),
  spec_revision_id uuid not null unique references task_spec_revision (id),
  status varchar(16) not null,
  reason varchar(64),
  applied_at timestamptz not null,
  constraint discovery_application_status check (status in ('applied', 'rejected')),
  constraint discovery_application_status_fields check (
    (status = 'applied' and reason is null)
    or (status = 'rejected' and reason is not null)
  ),
  constraint discovery_application_digest check (source_digest ~ '^[a-f0-9]{64}$'),
  constraint discovery_application_permit_version check (permit_version > 0),
  constraint discovery_application_verification_object check (
    jsonb_typeof(verification) = 'object' and octet_length(verification::text) <= 65536
  )
);

-- 槽位占用：每个槽位至多一行，人工认领与自动立项共用。
create table discovery_slot_occupation (
  id uuid primary key,
  project_id uuid not null references project (id),
  slot_id uuid not null unique references discovery_slot (id),
  task_id uuid not null unique references task (id),
  work_id uuid unique references work (id),
  application_id uuid unique references discovery_application (id),
  source varchar(16) not null,
  created_at timestamptz not null,
  constraint discovery_slot_occupation_source check (source in ('auto', 'manual')),
  constraint discovery_slot_occupation_fields check (
    (source = 'auto' and work_id is not null and application_id is not null)
    or (source = 'manual')
  )
);

-- 固定来源绑定：只由 Hub 物化，RD-04c 的专用读取与派发复核同一行。
create table discovery_source_binding (
  id uuid primary key,
  application_id uuid not null unique references discovery_application (id),
  project_id uuid not null references project (id),
  work_id uuid not null unique references work (id),
  task_id uuid not null unique references task (id),
  slot_id uuid not null references discovery_slot (id),
  source_id uuid not null references task_message (id),
  source_version varchar(64) not null,
  source_digest char(64) not null,
  verification jsonb not null,
  created_at timestamptz not null,
  constraint discovery_source_binding_digest check (source_digest ~ '^[a-f0-9]{64}$'),
  constraint discovery_source_binding_verification_object check (
    jsonb_typeof(verification) = 'object' and octet_length(verification::text) <= 65536
  )
);

-- 来源更正：原作者版本化改正文，原文不动；发现链与候选绑定改读最新版本。
create table discovery_source_correction (
  id uuid primary key,
  source_id uuid not null references task_message (id),
  project_id uuid not null references project (id),
  author_user_id uuid not null references user_account (id),
  version integer not null,
  body text not null,
  digest char(64) not null,
  created_at timestamptz not null,
  constraint discovery_source_correction_version check (version >= 1),
  constraint discovery_source_correction_body check (
    length(btrim(body)) between 1 and 20000
  ),
  constraint discovery_source_correction_digest check (digest ~ '^[a-f0-9]{64}$'),
  constraint discovery_source_correction_version_unique unique (source_id, version)
);

-- 候选的立项尝试记录：避免每个 tick 重复告警，同时保留可重试的目录变化。
alter table discovery_candidate
  add column creation_checked_at timestamptz,
  add column creation_reason varchar(64),
  add column creation_terminal boolean not null default false;
