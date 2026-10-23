-- 交付物审阅：批注线程与审阅邀请（#429；ADR-0021 §2-4）。
-- 版本身份就是 artifact 行：批注/邀请永远锚定一个不可变 Artifact 版本；
-- 新版是另一件 Artifact，不在这里改旧意见。

create type artifact_comment_kind as enum ('whole', 'text');
create type artifact_review_invitation_status as enum ('pending', 'submitted');

create table artifact_comment (
  id uuid primary key,
  artifact_id uuid not null references artifact(id),
  author_user_id uuid not null references user_account(id),
  parent_comment_id uuid references artifact_comment(id),
  kind artifact_comment_kind not null,
  -- whole：null；text：{quote,prefix,suffix,start,end}（版本内 UTF-16 偏移）。
  anchor jsonb,
  body varchar(10000) not null,
  created_at timestamptz not null default now(),
  constraint artifact_comment_body_length check (length(btrim(body)) between 1 and 10000),
  constraint artifact_comment_anchor_matches_kind check (
    (kind = 'whole' and anchor is null)
    or (kind = 'text' and anchor is not null and jsonb_typeof(anchor) = 'object')
  ),
  constraint artifact_comment_not_self_reply check (parent_comment_id is null or parent_comment_id <> id)
);

create index artifact_comment_by_artifact on artifact_comment (artifact_id, created_at, id);
create index artifact_comment_by_author on artifact_comment (artifact_id, author_user_id);

-- 每人每版本至多一条邀请；状态只表达「待提交意见 / 已提交（含本轮无意见）」。
create table artifact_review_invitation (
  id uuid primary key,
  artifact_id uuid not null references artifact(id),
  inviter_user_id uuid not null references user_account(id),
  reviewer_user_id uuid not null references user_account(id),
  focus varchar(2000),
  status artifact_review_invitation_status not null default 'pending',
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  constraint artifact_review_invitation_focus_length check (
    focus is null or length(btrim(focus)) between 1 and 2000
  ),
  constraint artifact_review_invitation_fields check (
    (status = 'pending' and submitted_at is null)
    or (status = 'submitted' and submitted_at is not null)
  ),
  constraint artifact_review_invitation_unique_per_reviewer unique (artifact_id, reviewer_user_id)
);

create index artifact_review_invitation_by_reviewer
  on artifact_review_invitation (reviewer_user_id, status);
create index artifact_review_invitation_by_artifact
  on artifact_review_invitation (artifact_id, created_at);
