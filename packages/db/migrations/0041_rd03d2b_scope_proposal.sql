-- ADR-0028 §8/§17（RD-03d2b）：authorize_scope 回答生成的 Mandate 草案。
-- 提案只保存已经过 CreateWorkMandateSchema 校验的范围 JSON 与引用；确认前不扩大
-- 当前 Mandate，也不派发任何关联意图。

create table work_mandate_proposal (
  id uuid primary key,
  work_id uuid not null references work (id),
  task_id uuid not null references task (id),
  project_id uuid not null references project (id),
  work_key varchar(64) not null,
  question_id uuid not null references work_question (id),
  answer_id uuid not null references work_question_answer (id),
  decision_id char(64) not null,
  base_mandate_id uuid not null references work_mandate (id),
  base_mandate_version integer not null,
  principal_user_id uuid not null references user_account (id),
  scope jsonb not null,
  status varchar(16) not null default 'pending',
  result_mandate_id uuid references work_mandate (id),
  confirmed_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint work_mandate_proposal_decision_format check (decision_id ~ '^[0-9a-f]{64}$'),
  constraint work_mandate_proposal_base_version check (base_mandate_version >= 1),
  constraint work_mandate_proposal_work_key_format check (
    work_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  constraint work_mandate_proposal_status check (
    status in ('pending', 'confirmed', 'superseded', 'expired', 'cancelled')
  ),
  constraint work_mandate_proposal_status_fields check (
    (status = 'pending' and confirmed_at is null and closed_at is null and result_mandate_id is null)
    or (
      status = 'confirmed'
      and confirmed_at is not null
      and closed_at is not null
      and result_mandate_id is not null
    )
    or (
      status in ('superseded', 'expired', 'cancelled')
      and confirmed_at is null
      and closed_at is not null
      and result_mandate_id is null
    )
  ),
  constraint work_mandate_proposal_scope_object check (
    jsonb_typeof(scope) = 'object' and octet_length(scope::text) <= 8192
  )
);

-- 一个问题至多一份草案；同一草案只对应一条 binding 回答。
create unique index work_mandate_proposal_question_unique
  on work_mandate_proposal (question_id);
create unique index work_mandate_proposal_answer_unique
  on work_mandate_proposal (answer_id);
create index work_mandate_proposal_work_status_idx
  on work_mandate_proposal (work_id, status, created_at desc);

-- authorize_scope 回答先落 answered，确认后才 superseded；两者都保留 answered_at。
alter table work_question drop constraint work_question_status_fields;
alter table work_question add constraint work_question_status_fields check (
  (status = 'open' and answered_at is null and closed_at is null)
  or (status = 'answered' and answered_at is not null and closed_at is not null)
  or (status = 'superseded' and closed_at is not null)
  or (status in ('expired', 'cancelled') and answered_at is null and closed_at is not null)
);
