-- ADR-0028 §8（RD-03d2a）：ask/decisionId 决策账本与可绑定回答。
-- 问题与回答只存协调元数据、引用与候选文本，不存来源正文。

create type work_question_type as enum ('choose_option', 'authorize_scope');
create type work_question_status as enum ('open', 'answered', 'superseded', 'expired', 'cancelled');
create type work_answer_type as enum ('choose_option', 'deny', 'defer', 'authorize_scope');

create table work_question (
  id uuid primary key,
  work_id uuid not null references work (id),
  task_id uuid not null references task (id),
  project_id uuid not null references project (id),
  decision_id char(64) not null,
  question_type work_question_type not null,
  blocked_decision varchar(64) not null,
  summary varchar(500) not null,
  options jsonb not null,
  recommended_option_id varchar(64),
  refs jsonb not null default '{}'::jsonb,
  input_digest char(64) not null,
  mandate_id uuid not null references work_mandate (id),
  mandate_version integer not null,
  principal_user_id uuid not null references user_account (id),
  dispatch_intent_id uuid references dispatch_intent (id),
  status work_question_status not null default 'open',
  answered_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_question_decision_format check (decision_id ~ '^[0-9a-f]{64}$'),
  constraint work_question_input_digest_format check (input_digest ~ '^[0-9a-f]{64}$'),
  constraint work_question_mandate_version check (mandate_version >= 1),
  constraint work_question_blocked_decision_length
    check (length(btrim(blocked_decision)) between 1 and 64),
  constraint work_question_summary_length check (length(btrim(summary)) between 1 and 500),
  constraint work_question_options_shape check (
    jsonb_typeof(options) = 'array'
    and jsonb_array_length(
      case when jsonb_typeof(options) = 'array' then options else '[]'::jsonb end
    ) between 1 and 8
    and octet_length(options::text) <= 4096
  ),
  constraint work_question_refs_object check (jsonb_typeof(refs) = 'object'),
  constraint work_question_refs_size check (octet_length(refs::text) <= 4096),
  constraint work_question_status_fields check (
    (status = 'open' and answered_at is null and closed_at is null)
    or (status = 'answered' and answered_at is not null and closed_at is not null)
    or (status in ('superseded', 'expired', 'cancelled') and answered_at is null and closed_at is not null)
  )
);

create unique index work_question_open_decision_unique
  on work_question (decision_id)
  where status = 'open';
create index work_question_work_created_idx
  on work_question (work_id, created_at desc, id);
create index work_question_work_status_idx
  on work_question (work_id, status, created_at desc);
create index work_question_principal_created_idx
  on work_question (principal_user_id, created_at desc, id);

create table work_question_answer (
  id uuid primary key,
  question_id uuid not null references work_question (id),
  decision_id char(64) not null,
  actor_user_id uuid not null references user_account (id),
  answer_type work_answer_type not null,
  option_id varchar(64),
  reason varchar(500),
  mandate_id uuid not null references work_mandate (id),
  mandate_version integer not null,
  binding boolean not null,
  rejection_reason varchar(64),
  created_at timestamptz not null default now(),
  constraint work_question_answer_decision_format check (decision_id ~ '^[0-9a-f]{64}$'),
  constraint work_question_answer_mandate_version check (mandate_version >= 1),
  constraint work_question_answer_reason_length
    check (reason is null or length(btrim(reason)) between 1 and 500),
  constraint work_question_answer_option_shape check (
    (answer_type = 'choose_option' and option_id is not null)
    or (answer_type <> 'choose_option' and option_id is null)
  ),
  constraint work_question_answer_binding_fields check (
    (binding and rejection_reason is null)
    or (not binding and rejection_reason is not null)
  )
);

create unique index work_question_answer_binding_unique
  on work_question_answer (question_id)
  where binding;
create index work_question_answer_question_created_idx
  on work_question_answer (question_id, created_at desc, id);
